import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

export const runtime = "nodejs";

type RecordingMeta = {
  inputSource?: string;
  aimStyle?: string;
  fullRange?: boolean;
  source?: string;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname, clientPayload) => ({
        allowedContentTypes: ["video/webm", "video/mp4"],
        addRandomSuffix: true,
        tokenPayload: clientPayload ?? null,
      }),
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) {
          console.error("RESEND_API_KEY not set — skipping email");
          return;
        }
        let meta: RecordingMeta = {};
        try {
          if (tokenPayload) meta = JSON.parse(tokenPayload) as RecordingMeta;
        } catch {
          // ignore malformed payload
        }

        const sizeMb = (blob.size ?? 0) / (1024 * 1024);
        const metaLines: string[] = [];
        if (meta.source) metaLines.push(`<li>Source: ${meta.source}</li>`);
        if (meta.inputSource) metaLines.push(`<li>Input: ${meta.inputSource}</li>`);
        if (meta.aimStyle) metaLines.push(`<li>Aim style: ${meta.aimStyle}</li>`);
        if (typeof meta.fullRange === "boolean") {
          metaLines.push(`<li>Range: ${meta.fullRange ? "360" : "front"}</li>`);
        }

        const resend = new Resend(apiKey);
        await resend.emails.send({
          from: "Sehej's World <onboarding@resend.dev>",
          to: "sehej@neuralink.com",
          subject: `New recording: ${blob.pathname}`,
          html: `
            <p>A new Sehej's World recording is ready.</p>
            <p><a href="${blob.url}">${blob.pathname}</a> (${sizeMb.toFixed(1)} MB)</p>
            ${metaLines.length ? `<ul>${metaLines.join("")}</ul>` : ""}
          `,
        });
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    console.error("share-recording error", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }
}
