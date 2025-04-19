import { google } from 'googleapis';
import nodemailer from "nodemailer";
import cron from 'node-cron';
import Customer from '../models/Customer';
require("dotenv").config();

const Secret = process.env.SECRET;
const clientId = process.env.CLIENT_ID;
const refreshToken = process.env.REFRESH_TOKEN;
const redirectUri = process.env.REDIRECT_URI;
const user = process.env.EMAIL;

async function sendMail({ message, title, email} : { message: string, title: string, email: string }) {
    console.log(Secret);
    console.log(clientId);
    console.log(refreshToken);
    console.log(redirectUri);
    console.log(email);
    const oAuth2Client = new google.auth.OAuth2(
        clientId,
        Secret,
        redirectUri
    );

    oAuth2Client.setCredentials({
        refresh_token: refreshToken
    });

    const accessTokenObj = await oAuth2Client.getAccessToken();
    const accessToken = accessTokenObj?.token;

    if (!accessToken) {
        throw new Error("Failed to get access token");
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            type: "OAuth2",
            user: user,
            clientId: clientId,
            clientSecret: Secret,
            refreshToken: refreshToken,
            accessToken: accessToken,
        }
    });

    const mailOptions = {
        from: `"I Store Digital" <${email}>`,
        to: email,
        subject: title,
        html: message,
    };

    await transporter.sendMail(mailOptions);
}

export const wishBirthDay = async ({email, dob, name }: {
    email: string,
    dob: Date,
    name: string
}) : Promise<void> => {
    const mail = generateBirthdayEmail(name, dob);
    await sendMail({ message: mail.html, title: mail.title, email })
}

interface BirthdayEmail {
    title: string;
    html: string;
}

function generateBirthdayEmail(name: string, date: Date): BirthdayEmail {
    const formattedDate = date.toLocaleDateString('en-IN', {
        month: 'long',
        day: 'numeric'
    });

    const html = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f9f9f9; padding: 30px;">
        <div style="max-width: 600px; margin: auto; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background-color: #ff6f61; padding: 24px; color: white; text-align: center;">
                <h1 style="margin: 0; font-size: 28px;">🎉 Happy Birthday, ${name}!</h1>
            </div>
            <div style="padding: 24px; text-align: center;">
                <p style="font-size: 18px; color: #333;">
                    Wishing you a wonderful day on <strong>${formattedDate}</strong>!<br/>
                    From all of us at <strong>I Store Digital</strong>, may your year ahead be filled with joy, success, and beautiful moments. 🥳
                </p>
            </div>
            <div style="background-color: #f1f1f1; padding: 16px; text-align: center; font-size: 14px; color: #777;">
                <p>With love,</p>
                <p><strong>I Store Digital Team</strong></p>
            </div>
        </div>
    </div>`;

    return {
        title: ` 🎉 Happy Birthday, ${name}!`,
        html
    };
}

export const wishBirthDayToCustomers = async () => {
    try {
        const now = new Date();

        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        const customers = await Customer.find({
            dob: {
                $gte: startOfDay,
                $lt: endOfDay
            },
            email: {$exists: true},
        }, {
            name: true,
            email: true,
        }).lean<{ name: string, email: string }[]>();

        for (const customer of customers) {
            const mail = generateBirthdayEmail(customer.name, now);
            await sendMail({message: mail.html, title: mail.title, email: customer.email})
        }
    } catch (e) {
        console.log("Error wishing birthday to customers", e);
    }
}