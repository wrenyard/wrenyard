import { QuotaService, currentCodeBuddyContext } from '@wrenyard/quota';
export async function handleQuota(args: string[]): Promise<number> {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: wrenyard quota [provider] [--json] [--refresh]');
        return 0;
    }
    const positional = args.filter(arg => !arg.startsWith('-'));
    if (positional.length > 1 || args.some(arg => arg.startsWith('-') && !['--json', '--refresh'].includes(arg))) {
        console.error('Usage: wrenyard quota [provider] [--json] [--refresh]');
        return 2;
    }
    const service = new QuotaService(), context = await currentCodeBuddyContext();
    const rows = positional[0] ? [await service.fetch(positional[0], context)].filter(row => row !== undefined) : await service.list(context);
    if (args.includes('--json'))
        console.log(JSON.stringify(rows, null, 2));
    else
        for (const row of rows) {
            const detail = row.windows?.map(w => w.name + ': ' + w.pct.toFixed(1) + '% used').join(', ') || row.balances?.map(b => b.amount + ' ' + b.currency).join(', ') || row.message || row.error || 'No observable quota';
            console.log(row.provider + ' [' + row.status + '] ' + detail);
        }
    return positional[0] && rows.some(row => row.status !== 'ok') ? 1 : 0;
}
