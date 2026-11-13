import { NextResponse } from "next/server";
import { isBroker } from "../../../../lib/brokers";
import { parseStatement } from "../../../../lib/external";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Parse an uploaded statement PDF and return a preview. Nothing is saved until the user confirms. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const broker = form.get("broker"), file = form.get("file"), password = String(form.get("password") ?? "") || undefined;
    if (!isBroker(broker)) return NextResponse.json({ error: "Pick a broker." }, { status: 400 });
    if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "Choose a PDF file." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "File is larger than 15 MB." }, { status: 400 });
    const kind = /\.csv$/i.test(file.name) || file.type === "text/csv" ? "csv" : "pdf";
    const r = await parseStatement(new Uint8Array(await file.arrayBuffer()), broker, password, kind);
    if (!r.holdings.length) return NextResponse.json({ error: kind === "csv" ? "No holdings found in this CSV. It needs a header row with at least Name and Quantity columns." : r.chars ? "No holding rows recognised in this PDF. Make sure it is a holdings statement (not a ledger or contract note)." : "No text found in the PDF (a scanned image?)." }, { status: 422 });
    return NextResponse.json(r);
  } catch (e) {
    const err = e as Error & { name?: string };
    const pw = err.name === "PasswordException" || /password/i.test(err.message);
    return NextResponse.json({ error: pw ? "This PDF is password protected. Enter its password and try again." : `Could not read the PDF: ${err.message}` }, { status: pw ? 401 : 500 });
  }
}
