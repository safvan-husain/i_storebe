import {Request, Response} from 'express';
import asyncHandler from "express-async-handler";
import Lead from "../../models/Lead";
import {onCatchError} from "../../middleware/error";
import {Schema, Types} from "mongoose";
import {staticsFilterSchema} from "./validation";

export const getLeadsStatics = asyncHandler(
    async (req: Request, res: Response) => {
        try {
            let { startDate, endDate, managerId } = staticsFilterSchema.parse(req.query);
            let manager = managerId ? new Types.ObjectId(managerId) : undefined;
            if (req.privilege === 'staff') {
                res.status(403).json({ message: "staffs not allowed not access analytics"});
                return;
            }
            if(req.privilege === 'manager') {
                manager = new Types.ObjectId(req.userId);
            }
            const analytics = await _getLeadsAnalytics({ startDate, endDate, managerId: manager });
            res.status(200).json(analytics);
        } catch (e) {
           onCatchError(e, res);
        }
    }
);

const _getLeadsAnalytics = async ({startDate, endDate, managerId }: { startDate?: Date, endDate?: Date, managerId?: Types.ObjectId }) => {
    let match: any = {};
    //if start and end date provided, filter with them first.
    if (startDate) {
        match.createdAt.$gte = startDate;
    }
    if (endDate) {
        match.createdAt.$lte = endDate;
    }

    if(managerId) {
        match.manager = managerId;
    }

    let pipeline = [];
    if (Object.keys(match).length > 0) {
        pipeline.push(match);
    }
    let result = await Lead.aggregate([
        ...pipeline,
        {
            $facet: {
                status: [
                    {
                        $group: {
                            _id: null,
                            // EnquireStatus counts
                            empty: {$sum: {$cond: [{$eq: ["$enquireStatus", "empty"]}, 1, 0]}},
                            contacted: {$sum: {$cond: [{$eq: ["$enquireStatus", "contacted"]}, 1, 0]}},
                            interested: {$sum: {$cond: [{$eq: ["$enquireStatus", "interested"]}, 1, 0]}},
                            lost: {$sum: {$cond: [{$eq: ["$enquireStatus", "lost"]}, 1, 0]}},
                            new: {$sum: {$cond: [{$eq: ["$enquireStatus", "new"]}, 1, 0]}},
                            none: {$sum: {$cond: [{$eq: ["$enquireStatus", "none"]}, 1, 0]}},
                            pending: {$sum: {$cond: [{$eq: ["$enquireStatus", "pending"]}, 1, 0]}},
                            quotation_shared: {$sum: {$cond: [{$eq: ["$enquireStatus", "quotation shared"]}, 1, 0]}},
                            visit_store: {$sum: {$cond: [{$eq: ["$enquireStatus", "visit store"]}, 1, 0]}},
                            won: {$sum: {$cond: [{$eq: ["$enquireStatus", "won"]}, 1, 0]}},

                            // EnquireSource counts
                            call: {$sum: {$cond: [{$eq: ["$enquireSource", "call"]}, 1, 0]}},
                            facebook: {$sum: {$cond: [{$eq: ["$enquireSource", "facebook"]}, 1, 0]}},
                            instagram: {$sum: {$cond: [{$eq: ["$enquireSource", "instagram"]}, 1, 0]}},
                            previous_customer: {$sum: {$cond: [{$eq: ["$enquireSource", "previous customer"]}, 1, 0]}},
                            wabis: {$sum: {$cond: [{$eq: ["$enquireSource", "wabis"]}, 1, 0]}},
                            walkin: {$sum: {$cond: [{$eq: ["$enquireSource", "walkin"]}, 1, 0]}},
                            whatsapp: {$sum: {$cond: [{$eq: ["$enquireSource", "whatsapp"]}, 1, 0]}},

                            // Purpose counts
                            inquire: {$sum: {$cond: [{$eq: ["$purpose", "inquire"]}, 1, 0]}},
                            purchase: {$sum: {$cond: [{$eq: ["$purpose", "purchase"]}, 1, 0]}},
                            sales: {$sum: {$cond: [{$eq: ["$purpose", "sales"]}, 1, 0]}},
                            service_request: {$sum: {$cond: [{$eq: ["$purpose", "service request"]}, 1, 0]}}
                        }
                    }
                ],
                progress: [
                    {
                        $group: {
                            _id: {$dateToString: {format: "%Y-%m-%d", date: "$createdAt"}},
                            count: {$sum: 1}
                        }
                    },
                    {
                        $sort: {_id: 1} // Sort by date (ascending)
                    }
                ]
            }

        }
    ]);
    const status = result[0].status[0];
    const progress = result[0].progress.map((e: any) => ({
        ...e,
        date: new Date(e._id).getTime()
    }));
    return {
        enquireStatus: {
            empty: status.empty,
            contacted: status.contacted,
            interested: status.interested,
            lost: status.lost,
            new: status.new,
            none: status.none,
            pending: status.pending,
            quotation_shared: status.quotation_shared,
            visit_store: status.visit_store,
            won: status.won
        },
        enquireSource: {
            call: status.call,
            facebook: status.facebook,
            instagram: status.instagram,
            previous_customer: status.previous_customer,
            wabis: status.wabis,
            walkin: status.walkin,
            whatsapp: status.whatsapp
        },
        purpose: {
            inquire: status.inquire,
            purchase: status.purchase,
            sales: status.sales,
            service_request: status.service_request
        },
        progress
    };
}