import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import connectDb from '../config/db';
import User from '../models/User';

type Args = {
  password: string;
  dryRun: boolean;
};

const DEFAULT_PASSWORD = '12345678';

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const parsed: Args = {
    password: DEFAULT_PASSWORD,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--password' || arg === '-p') {
      parsed.password = args[i + 1] ?? parsed.password;
      i++;
      continue;
    }

    if (arg.startsWith('--password=')) {
      parsed.password = arg.split('=')[1] || parsed.password;
      continue;
    }

    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
  }

  return parsed;
};

const run = async () => {
  const { password, dryRun } = parseArgs();

  await connectDb();

  const users = await User.find({}, { username: true }).lean();
  if (users.length === 0) {
    console.log('No users found. Nothing to update.');
    await mongoose.connection.close();
    return;
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: 'dry-run',
          password: password,
          userCount: users.length,
          usernames: users.map((user) => user.username),
        },
        null,
        2
      )
    );
    await mongoose.connection.close();
    return;
  }

  const result = await User.updateMany(
    {},
    {
      $set: {
        password: hashedPassword,
        isNewPassword: false,
      },
      $unset: {
        token: '',
      },
    }
  );

  console.log(
    JSON.stringify(
      {
        mode: 'apply',
        password: password,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      },
      null,
      2
    )
  );

  await mongoose.connection.close();
};

run().catch(async (error) => {
  console.error('Failed to reset passwords:', error);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
