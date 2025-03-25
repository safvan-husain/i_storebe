import {Response} from "express";

export interface ErrorMessage {
    message: string;
}

export interface TypedResponse<T> extends Response {
    json: (body: T | ErrorMessage) => this;
}
