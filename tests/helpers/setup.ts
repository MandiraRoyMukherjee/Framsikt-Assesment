import { FakeChat, FakeClock, FakeDirectory, FakeHr } from "../../src/adapters/fakes";
import { InMemoryRefillRepository } from "../../src/adapters/inMemoryRepository";
import { BENGALURU, DEFAULT_CONFIG, OFFICES, OSLO } from "../../src/domain/config";
import type { Config } from "../../src/domain/config";
import type { Employee } from "../../src/domain/types";
import { RefillService } from "../../src/services/refillService";

export const HOUR = 3_600_000;
/** Tuesday 10 March 2026, 09:00 UTC (10:00 in Oslo, 14:30 in Bengaluru). */
export const START = new Date("2026-03-10T09:00:00Z");

export function emp(id: string, home: "OSL" | "BLR", volunteer = true): Employee {
  return { id, name: id, homeOfficeId: home, payrollCurrency: home === "OSL" ? "NOK" : "INR", isVolunteer: volunteer };
}

export function setup(employees: Employee[], config: Partial<Config> = {}) {
  const clock = new FakeClock(START);
  const repo = new InMemoryRefillRepository();
  const chat = new FakeChat();
  const hr = new FakeHr();
  const directory = new FakeDirectory();
  employees.forEach((e) => directory.add(e));
  let n = 0;
  const service = new RefillService({
    repo,
    chat,
    hr,
    directory,
    clock,
    offices: OFFICES,
    config: { ...DEFAULT_CONFIG, ...config },
    idGenerator: () => `refill-${++n}`,
  });
  return { clock, repo, chat, hr, directory, service, OSLO, BENGALURU };
}
