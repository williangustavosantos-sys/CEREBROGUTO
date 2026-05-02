// Generates a 1080x1350 workout validation poster using sharp.
// Returns { posterBuffer, thumbBuffer }.
import sharp from "sharp";

const POSTER_WIDTH = 1080;
const POSTER_HEIGHT = 1350;
const THUMB_WIDTH = 400;
const THUMB_HEIGHT = 500;

// Selfie area: top portion (roughly 70% height)
const SELFIE_AREA_HEIGHT = Math.round(POSTER_HEIGHT * 0.70);
const BANNER_HEIGHT = POSTER_HEIGHT - SELFIE_AREA_HEIGHT;

export async function generateWorkoutPoster(params: {
  imageBase64: string;
  workoutLabel: string;
  dateLabel: string;
  xp: number;
}): Promise<{ posterBuffer: Buffer; thumbBuffer: Buffer }> {
  const { imageBase64, workoutLabel, dateLabel, xp } = params;

  if (!imageBase64) throw new Error("imageBase64 is required");

  // Strip data URL prefix if present
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
  if (!base64Data) throw new Error("Invalid imageBase64: empty after stripping prefix");
  const photoBuffer = Buffer.from(base64Data, "base64");

  // Resize and center-crop the selfie to fit the selfie area
  const selfieCropped = await sharp(photoBuffer)
    .resize(POSTER_WIDTH, SELFIE_AREA_HEIGHT, { fit: "cover", position: "center" })
    .jpeg({ quality: 85 })
    .toBuffer();

  // Build bottom banner SVG with text overlay
  const svgBanner = `
<svg width="${POSTER_WIDTH}" height="${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${POSTER_WIDTH}" height="${BANNER_HEIGHT}" fill="#0D2341"/>
  <text x="54" y="68" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="bold" fill="#00E5FF">VALIDADO · +${xp} XP</text>
  <text x="54" y="130" font-family="Arial, Helvetica, sans-serif" font-size="38" fill="#FFFFFF">${escapeXml(workoutLabel)}</text>
  <text x="54" y="188" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#8AABC4">${escapeXml(dateLabel)}</text>
</svg>`;

  const svgBannerBuffer = Buffer.from(svgBanner);

  // Compose: selfie on top, dark banner on bottom
  const posterBuffer = await sharp({
    create: {
      width: POSTER_WIDTH,
      height: POSTER_HEIGHT,
      channels: 3,
      background: { r: 13, g: 35, b: 65 }, // #0D2341
    },
  })
    .composite([
      { input: selfieCropped, top: 0, left: 0 },
      { input: svgBannerBuffer, top: SELFIE_AREA_HEIGHT, left: 0 },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();

  // Thumbnail: resize poster
  const thumbBuffer = await sharp(posterBuffer)
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: "cover", position: "center" })
    .jpeg({ quality: 80 })
    .toBuffer();

  return { posterBuffer, thumbBuffer };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
