import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User';
import connectDb from '../config/db';

type Args = {
  username?: string;
  password?: string;
  forceLogout?: boolean;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const parsed: Args = {};

  const getVal = (i: number) => (i + 1 < args.length ? args[i + 1] : undefined);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--username' || a === '-u') {
      parsed.username = getVal(i);
      i++;
      continue;
    }
    if (a.startsWith('--username=')) {
      parsed.username = a.split('=')[1];
      continue;
    }
    if (a === '--password' || a === '-p') {
      parsed.password = getVal(i);
      i++;
      continue;
    }
    if (a.startsWith('--password=')) {
      parsed.password = a.split('=')[1];
      continue;
    }
    if (a === '--force-logout' || a === '--logout') {
      parsed.forceLogout = true;
      continue;
    }
  }

  // Fallback: support positional args: <username> <password>
  if (!parsed.username && args[0] && !args[0].startsWith('-')) parsed.username = args[0];
  if (!parsed.password && args[1] && !args[1].startsWith('-')) parsed.password = args[1];

  return parsed;
};

const usage = () => {
  console.log(
    'Usage: ts-node src/scripts/changePassword.ts --username <username> --password <newPassword> [--force-logout]'
  );
  console.log('   or: npm run change-password -- -u <username> -p <newPassword>');
};

const run = async () => {
  const { username, password, forceLogout } = parseArgs();

  if (!username || !password) {
    usage();
    process.exit(1);
    return;
  }

  await connectDb();

  const user = await User.findOne({ username });
  if (!user) {
    console.error(`User not found: ${username}`);
    await mongoose.connection.close();
    process.exit(1);
    return;
  }

  user.password = password; // Will be hashed by pre('save') hook

  if (forceLogout) {
    // Clear token and flag password change if your app uses these semantics
    user.token = undefined as any;
    user.isNewPassword = true;
  }

  try {
    await user.save();
    console.log(`Password updated for user: ${username}`);
    if (forceLogout) {
      console.log('Existing session cleared (force logout).');
    }
  } catch (err: any) {
    console.error('Failed to update password:', err?.message || err);
    await mongoose.connection.close();
    process.exit(1);
    return;
  }

  await mongoose.connection.close();
  process.exit(0);
};

run().catch(async (err) => {
  console.error('Unexpected error:', err);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});

