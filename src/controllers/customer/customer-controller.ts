import { Request } from 'express';
import { TypedResponse } from "../../common/interface";

import * as ExcelJS from 'exceljs';
import Lead from '../../models/Lead';
import Activity from '../../models/Activity';
import {optionalDateQueryFiltersSchema} from "../../common/types";
import {FilterQuery} from "mongoose";
import {onCatchError} from "../../middleware/error";

export const generateCustomerExcelFile = async (req: Request, res: TypedResponse<any>) => {
    try {
        const { startDate, endDate } = optionalDateQueryFiltersSchema.parse(req.query);
        
        const query: FilterQuery<any> = {};
        if (startDate && endDate) {
            query.createdAt = {
                $gte: startDate,
                $lte: endDate
            };
        }

        const leads: any[] = await Lead
            .find(query)
            .populate('customer', 'name phone email address')
            .lean();

        // Build a map of leadId -> last dialed datetime
        const leadIds = leads.map(l => l._id).filter(Boolean);
        let lastDialedMap = new Map<string, Date>();
        if (leadIds.length) {
            const lastDialed = await Activity.aggregate<{ _id: any, lastDialed: Date }>([
                { $match: { type: 'dialed', lead: { $in: leadIds } } },
                { $group: { _id: '$lead', lastDialed: { $max: '$createdAt' } } }
            ]);
            lastDialed.forEach(doc => {
                lastDialedMap.set(String(doc._id), doc.lastDialed);
            });
        }
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Leads');

        worksheet.columns = [
            { header: 'Name', key: 'name', width: 20 },
            { header: 'Phone', key: 'phone', width: 15 },
            { header: 'Email', key: 'email', width: 25 },
            { header: 'Address', key: 'address', width: 30 },
            { header: 'Product', key: 'product', width: 20 },
            { header: 'Last Contacted', key: 'lastContacted', width: 24 },
            { header: 'Created At', key: 'createdAt', width: 20 }
        ];

        leads.forEach(lead => {
            const snapshot = lead.contactSnapshot || {};
            const customer = lead.customer || {};
            const name = snapshot.name ?? customer.name ?? '';
            const phone = snapshot.phone ?? customer.phone ?? '';
            const email = snapshot.email ?? customer.email ?? '';
            const address = snapshot.address ?? customer.address ?? '';
            const lastContacted = lastDialedMap.get(String(lead._id));
            worksheet.addRow({
                name,
                phone,
                email,
                address,
                product: lead.product ?? '',
                lastContacted: lastContacted ? new Date(lastContacted).toLocaleString() : '',
                createdAt: lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : ''
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=customers.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        onCatchError(error, res);
    }
}
