import type { SecondUserPrivilege, UserPrivilege } from '../common/types';
import type { Types } from 'mongoose';

declare global {
    namespace Express {
        interface Request {
            userId?: string;
            privilege: UserPrivilege;
            secondPrivilege: SecondUserPrivilege;
            manager?: Types.ObjectId;
            username?: string;
        }
    }
}

export {};
