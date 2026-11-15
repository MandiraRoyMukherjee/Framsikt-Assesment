import { describe, expect, it } from 'vitest';
import { major } from '../src/domain/money';
import { runScenario } from '../src/demo/scenario';

describe('demo scenario (real service + simulated chat/HR)', () => {
  it('runs end to end and produces a consistent two-currency report', async () => {
    const { timeline, report } = await runScenario();
    expect(timeline.length).toBeGreaterThan(10);

    const oslo = report.offices.find((o) => o.officeId === 'OSL')!;
    const blr = report.offices.find((o) => o.officeId === 'BLR')!;
    expect(oslo.spent).toEqual(major(840, 'NOK'));
    expect(blr.spent).toEqual(major(4350, 'INR'));
    expect(report.total).toEqual(major(840 + 4350 * 0.125, 'NOK'));
    expect(oslo.outstandingClaims).toBe(0); // HR approved everything
  });

  it('shows a timeout hand-over, an HR outage retry and a visitor refilling', async () => {
    const { timeline } = await runScenario();
    const text = timeline.map((t) => t.text).join('\n');
    expect(text).toContain('did not answer within 2h');
    expect(text).toContain('HR system is down');
    expect(text).toContain('visitor from Oslo');
  });
});
