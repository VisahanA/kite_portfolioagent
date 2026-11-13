import { oauthCallback } from "../../../../lib/api";
import { finishGmailAuth } from "../../../../lib/gmail";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => oauthCallback(req, "gmail", finishGmailAuth);
