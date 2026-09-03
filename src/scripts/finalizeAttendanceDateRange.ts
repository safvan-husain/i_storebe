import 'dotenv/config';
import connectDb from '../config/db';
import {
    finalizeAllBranchesForDateRange,
    FinalizeBranchResult,
} from '../services/attendance-finalize-daily';

type Args = {
    from: string;
    to: string;
};

const parseArgs = (): Args => {
    const argv = process.argv.slice(2);
    const fromArg = argv.find((value) => value.startsWith('--from='))?.split('=')[1];
    const toArg = argv.find((value) => value.startsWith('--to='))?.split('=')[1];
    if (!fromArg || !toArg) {
        throw new Error('Usage: npm run attendance:finalize-range -- --from=YYYY-MM-DD --to=YYYY-MM-DD');
    }
    return { from: fromArg, to: toArg };
};

const summarize = (results: FinalizeBranchResult[]) => {
    const byBranch = new Map<string, {
        branchName: string;
        dates: number;
        processed: number;
        createdOrUpdated: number;
        skipped: number;
        errors: number;
    }>();

    for (const result of results) {
        const existing = byBranch.get(result.branchId) ?? {
            branchName: result.branchName,
            dates: 0,
            processed: 0,
            createdOrUpdated: 0,
            skipped: 0,
            errors: 0,
        };
        existing.dates += 1;
        existing.processed += result.processed;
        existing.createdOrUpdated += result.createdOrUpdated;
        existing.skipped += result.skipped;
        existing.errors += result.errors.length;
        byBranch.set(result.branchId, existing);
    }

    return {
        branchCount: byBranch.size,
        dateRuns: results.length,
        createdOrUpdated: results.reduce((sum, item) => sum + item.createdOrUpdated, 0),
        skipped: results.reduce((sum, item) => sum + item.skipped, 0),
        errors: results.reduce((sum, item) => sum + item.errors.length, 0),
        branches: Array.from(byBranch.values()),
    };
};

const main = async () => {
    const args = parseArgs();
    await connectDb();
    const results = await finalizeAllBranchesForDateRange(args);
    const summary = summarize(results);
    console.log(JSON.stringify({ from: args.from, to: args.to, summary }, null, 2));
    process.exit(summary.errors > 0 ? 1 : 0);
};

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
