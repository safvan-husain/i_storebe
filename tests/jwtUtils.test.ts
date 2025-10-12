// Minimal unit test for src/utils/jwtUtils.ts without Jest
// Verifies that secondPrivilege is preserved after token encode/decode

import assert from 'assert';
import { Types } from 'mongoose';

async function run() {
  try {
    // Ensure jwtUtils picks up a deterministic secret at import time
    process.env.JWT_SECRET = 'unit-test-secret';

    // Dynamically import after setting env to ensure the constant is captured
    const { generateToken, verifyToken } = await import('../src/utils/jwtUtils');

    const userId = new Types.ObjectId();
    const user: any = {
      _id: userId,
      username: 'tester',
      password: 'secret',
      privilege: 'admin',
      secondPrivilege: 'super',
      isActive: true,
      isNewPassword: false,
    };

    const token = generateToken(user);
    assert.ok(token && typeof token === 'string', 'Expected token to be a string');

    const decoded: any = verifyToken(token);
    assert.ok(decoded, 'Expected decoded payload');

    // Core verification for the reported issue
    assert.strictEqual(
      decoded.secondPrivilege,
      'super',
      'secondPrivilege should be present and equal to the user value'
    );

    // Sanity checks
    assert.strictEqual(decoded.privilege, 'admin', 'privilege should be preserved');

    // If the implementation serializes ObjectId to string, allow string equality
    const decodedId = String(decoded.id);
    assert.strictEqual(decodedId, String(userId), 'id should match the user _id');

    console.log('jwtUtils secondPrivilege encode/decode test: PASSED');
    process.exit(0);
  } catch (err) {
    console.error('jwtUtils secondPrivilege encode/decode test: FAILED');
    console.error(err);
    process.exit(1);
  }
}

run();

