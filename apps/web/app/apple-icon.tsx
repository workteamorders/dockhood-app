import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #ff9a56, #f45b7a 48%, #3a2d6b)' }}>
        <svg width="160" height="160" viewBox="0 0 32 32" fill="none">
          <path d="M6 18C9 11 14 8 19 9L22 6L23 11C25 12 26 14 28 15L24 16C22 19 19 21 15 21L17 17C13 16 10 17 8 20L6 23L5 20L3 18H6Z" fill="#fff" />
          <circle cx="23" cy="13.5" r=".8" fill="#3a2d6b" />
          <path d="M11 25H25" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
    ),
    size,
  );
}
