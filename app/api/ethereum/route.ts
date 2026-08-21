import { NextResponse } from "next/server";
import { getTestPaymentDetails, verifyTestPayment } from "../../../lib/sepolia";

export const dynamic = "force-dynamic";

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : "Не удалось проверить сделку";
}

export async function GET() {
  try { return NextResponse.json({ payment: getTestPaymentDetails() }); }
  catch (reason) { return NextResponse.json({ error: message(reason) }, { status: 503 }); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { transaction_hash?: unknown };
    return NextResponse.json({ payment: await verifyTestPayment(body.transaction_hash) });
  } catch (reason) { return NextResponse.json({ error: message(reason) }, { status: 400 }); }
}
