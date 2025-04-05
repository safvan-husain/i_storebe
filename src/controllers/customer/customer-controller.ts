import {z} from "zod";
import { Request } from 'express';
import { TypedResponse } from "../../common/interface";

import * as ExcelJS from 'exceljs';
import Customer from '../../models/Customer';

export const generateCustomerExcelFile = async (req: Request, res: TypedResponse<any>) => {
    try {
        const { startDate, endDate } = req.body;
        
        const query: any = {};
        if (startDate && endDate) {
            query.createdAt = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }

        const customers = await Customer.find(query).lean();
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Customers');

        worksheet.columns = [
            { header: 'Name', key: 'name', width: 20 },
            { header: 'Phone', key: 'phone', width: 15 },
            { header: 'Email', key: 'email', width: 25 },
            { header: 'Address', key: 'address', width: 30 },
            { header: 'Date of Birth', key: 'dob', width: 15 },
            { header: 'Created At', key: 'createdAt', width: 20 }
        ];

        customers.forEach(customer => {
            worksheet.addRow({
                name: customer.name,
                phone: customer.phone,
                email: customer.email || '',
                address: customer.address,
                dob: customer.dob ? new Date(customer.dob).toLocaleDateString() : '',
                createdAt: new Date(customer.createdAt).toLocaleDateString()
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=customers.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        res.status(500).json({ message: 'Error generating excel file' });
    }
}