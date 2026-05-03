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

  // Build bottom banner SVG with text overlay - GUTO premium white/glass design
  const svgBanner = `
<svg width="${POSTER_WIDTH}" height="${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <!-- Off-white premium base -->
  <defs>
    <linearGradient id="bannerGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#EEF4FA"/>
    </linearGradient>
  </defs>
  <rect width="${POSTER_WIDTH}" height="${BANNER_HEIGHT}" fill="url(#bannerGrad)"/>
  <!-- Cyan accent top border line -->
  <rect x="0" y="0" width="${POSTER_WIDTH}" height="6" fill="#7FDDFF"/>
  <!-- GUTO badge pill (subtle) -->
  <rect x="54" y="38" width="130" height="44" rx="22" fill="rgba(127,221,255,0.18)" stroke="rgba(127,221,255,0.55)" stroke-width="1.5"/>
  <text x="119" y="68" font-family="monospace" font-size="20" font-weight="900" text-anchor="middle" letter-spacing="4" fill="#0D2341">GUTO</text>
  <!-- VALIDADO heading -->
  <text x="54" y="138" font-family="monospace" font-size="52" font-weight="900" letter-spacing="2" fill="#0D2341">VALIDADO</text>
  <!-- XP with cyan accent -->
  <text x="54" y="196" font-family="monospace" font-size="36" font-weight="900" letter-spacing="1" fill="#52E7FF">+${xp} XP</text>
  <!-- Workout label -->
  <text x="54" y="246" font-family="monospace" font-size="30" font-weight="700" letter-spacing="0" fill="rgba(13,35,65,0.78)">${escapeXml(workoutLabel)}</text>
  <!-- Date label -->
  <text x="54" y="296" font-family="monospace" font-size="24" font-weight="400" letter-spacing="0" fill="rgba(13,35,65,0.48)">${escapeXml(dateLabel)}</text>
  <!-- Decorative cyan dot accent right -->
  <circle cx="980" cy="80" r="28" fill="rgba(127,221,255,0.18)" stroke="rgba(127,221,255,0.38)" stroke-width="1.5"/>
  <circle cx="980" cy="80" r="10" fill="rgba(127,221,255,0.55)"/>
  <!-- Subtle separator line -->
  <line x1="54" y1="212" x2="540" y2="212" stroke="rgba(82,231,255,0.35)" stroke-width="1.5"/>
</svg>`;

  const svgBannerBuffer = Buffer.from(svgBanner);

  // Compose: selfie on top, dark banner on bottom
  const posterBuffer = await sharp({
    create: {
      width: POSTER_WIDTH,
      height: POSTER_HEIGHT,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }, // #FFFFFF — base branca premium
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
