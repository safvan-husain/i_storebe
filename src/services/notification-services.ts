import {Request, Response} from "express";
import {messaging} from 'firebase-admin';
import asyncHandler from "express-async-handler";
import {paginationSchema} from "../common/types";
import {TypedResponse} from "../common/interface";
import {Notification} from "../models/Notification";
import User from "../models/User";

export const getNotifications = asyncHandler(
    async (req: Request, res: TypedResponse<{
        title: string,
        description: string,
        lead: string,
        createdAt: number
    }[]>) => {
        try {
            const {skip, limit} = paginationSchema.parse(req.query);

            const notifications = await Notification
                .find({assigned: req.userId}, {title: 1, description: 1, lead: 1, createdAt: 1})
                .skip(skip).limit(limit)
                .lean<{ title: string, description: string, lead: string, createdAt: Date }[]>();
            res.status(200).json(notifications.map(e => ({...e, createdAt: e.createdAt.getTime()})));
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