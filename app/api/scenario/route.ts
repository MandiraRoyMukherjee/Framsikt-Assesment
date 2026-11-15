import { NextResponse } from "next/server";
import { runScenario } from "../../../src/demo/scenario";

export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json(await runScenario());
}
