import {Request, Response} from "express";
import {messaging} from 'firebase-admin';
import asyncHandler from "express-async-handler";
import {paginationSchema} from "../common/types";
import {TypedResponse} from "../common/interface";
import {Notification} from "../models/Notification";
import User, {IUser} from "../models/User";
import {ILead} from "../models/Lead";
import {ILeadResponse} from "../controllers/leads/leadController";
import {ICustomer} from "../models/Customer";

export const getNotifications = asyncHandler(
    async (req: Request, res: TypedResponse<{
        title: string,
        description: string,
        lead?: ILeadResponse,
        createdAt: number
    }[]>) => {
        try {
            const {skip, limit} = paginationSchema.parse(req.query);

            const notifications = await Notification
                .find({assigned: req.userId}, {title: 1, description: 1, lead: 1, createdAt: 1})
                .skip(skip).limit(limit)
                .populate({
                    path: 'lead',
                    populate: [
                        {
                            path: 'customer',
                            model: 'Customer'
                        },
                        {
                            path: 'handledBy',
                            model: "User"
                        }
                    ]
                })
                .lean<{ title: string, description: string, lead?: ILead<ICustomer | undefined, IUser | undefined>, createdAt: Date }[]>();
            res.status(200).json(notifications.map(e => {
                let lead: ILeadResponse | undefined;
                if (e.lead) {
                    lead = {
                        _id: e.lead._id,
                        handlerName: e.lead.handledBy?.username ?? "N/A",
                        source: e.lead.source,
                        enquireStatus: e.lead.enquireStatus,
                        purpose: e.lead.purpose,
                        callStatus: e.lead.callStatus,
                        type: e.lead.type,
                        product: e.lead.product,
                        nearestStore: e.lead.nearestStore,
                        name: e.lead.customer?.name ?? "N/A",
                        phone: e.lead.customer?.phone ?? "N/A",
                        email: e.lead.customer?.email ?? "N/A",
                        address: e.lead.customer?.address ?? "N/A",
                        dob: e.lead.customer?.dob?.getTime() ?? 0,
                        createdAt: e.lead.createdAt.getTime(),
                    };
                }
                return {
                    title: e.title,
                    description: e.description,
                    lead: lead,
                    createdAt: e.createdAt.getTime()
                }
            }));
        } catch (error) {
            console.log("error ar getNotification", error);
            res.status(500).json({message: "Internal server error"});
        }
    });


export const createNotificationForUsers =
    async (title: string, description: string, lead: string, assigned: string) => {
        console.log(`creating new notification for ${lead}`);
        await Notification.create({
            title,
            description,
            lead,
            assigned
        });
        sendPushNotification({title: "You have new lead", body: title, userId: assigned}).catch(e => console.error(e));
    }

const sendPushNotification = async ({title, body, userId}: {
    title: string,
    body: string,
    userId: string
}) => {
    let token = await User.findById(userId, {fcmToken: true}).lean<{ fcmToken?: string }>().then(e => e?.fcmToken);
    if (token) {
        messaging().send({
            data: {
                title,
                body
            },
            token
        }).then(e => {
            console.log(e);
        }).catch(e => {
            console.log(e);
        });
    } else {
        console.log(`user ${userId} does not have token`);
    }
}