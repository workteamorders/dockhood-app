export function Wordmark({ size = 28, dark = false }: { size?: number; dark?: boolean }) {
  return <span style={{ fontFamily: 'var(--font-ui)', fontWeight: 700, fontSize: size, lineHeight: 1.1, letterSpacing: '-.055em', whiteSpace: 'nowrap', color: dark ? '#fff' : 'var(--text-primary)' }}>Dockhood</span>;
}
