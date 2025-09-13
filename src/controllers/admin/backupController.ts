import { Request, Response } from 'express';
import { spawn } from 'child_process';
import { pipeline } from 'stream';

/**
 * Streams a gzipped mongodump archive directly to the HTTP response.
 * Requires req.privilege === 'admin'.
 */
export async function backupDatabase(req: Request, res: Response) {
  try {
    if (req.privilege !== 'admin') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/i-store-db';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `mongodb-backup-${ts}.gz`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    const args = ['--uri', mongoUri, '--archive', '--gzip'];
    const child = spawn('mongodump', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stderr.on('data', (d) => {
      // Log tool output to aid debugging if needed
      console.error('mongodump:', d.toString());
    });

    child.on('error', (err) => {
      console.error('Failed to start mongodump:', err);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to start mongodump' });
      } else {
        res.destroy(err as Error);
      }
    });

    // Stream the backup to the client; this keeps memory usage constant.
    pipeline(child.stdout!, res, (err) => {
      if (err) {
        console.error('Backup stream failed:', err);
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`mongodump exited with code ${code}`);
      }
    });
  } catch (e) {
    console.error('Unexpected error in backupDatabase:', e);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

