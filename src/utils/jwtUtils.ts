
import jwt from 'jsonwebtoken';
import { IUser } from '../models/User';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

export const generateToken = (user: IUser): string => {
  return jwt.sign(
    {
      id: user._id,
      privilege: user.privilege,
      secondPrivilege: user.secondPrivilege ?? 'regular',
    },
    JWT_SECRET
  );
};

export const verifyToken = (token: string): any => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
};
