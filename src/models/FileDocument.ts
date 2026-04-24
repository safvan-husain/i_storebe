import mongoose, { Document, Types } from 'mongoose';

export interface IFileDocument extends Document {
    _id: Types.ObjectId;
    fileName: string;
    originalName?: string;
    path: string;
    mimeType?: string;
    size?: number;
    uploadedBy?: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const FileDocumentSchema = new mongoose.Schema(
    {
        fileName: {
            type: String,
            required: true,
            trim: true,
        },
        originalName: {
            type: String,
            trim: true,
        },
        path: {
            type: String,
            required: true,
            trim: true,
        },
        mimeType: {
            type: String,
            trim: true,
        },
        size: {
            type: Number,
        },
        uploadedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    {
        timestamps: true,
    }
);

FileDocumentSchema.index({ uploadedBy: 1, createdAt: -1 });

const FileDocument = mongoose.model<IFileDocument>('FileDocument', FileDocumentSchema);

export default FileDocument;
