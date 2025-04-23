import { google } from 'googleapis';
import nodemailer from "nodemailer";
require("dotenv").config();

const Secret = process.env.SECRET;
const clientId = process.env.CLIENT_ID;
const refreshToken = process.env.REFRESH_TOKEN;
const redirectUri = process.env.REDIRECT_URI;
const email = process.env.EMAIL;

export async function sendMail({ message, title, email} : { message: string, title: string, email: string }) {
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
            user: email,
            clientId: clientId,
            clientSecret: Secret,
            refreshToken: refreshToken,
            accessToken: accessToken,
        }
    });

    const mailOptions = {
        from: `"I Store Digital" <${email}>`,
        to: "developer.safvan@gmail.com",
        subject: title,
        text: message,
        html: "<b>WITH DOTENV</b>"
    };

    const result = await transporter.sendMail(mailOptions);
}






