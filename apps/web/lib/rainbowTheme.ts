import { lightTheme, type Theme } from '@rainbow-me/rainbowkit';

const base = lightTheme({ accentColor: '#006bd6', accentColorForeground: '#fff', borderRadius: 'medium', fontStack: 'system' });

/** RainbowKit skinned to Dockhood's rounded glass window chrome. */
export const xpRainbowTheme: Theme = {
  ...base,
  colors: {
    ...base.colors,
    accentColor: '#006bd6',
    actionButtonBorder: 'rgba(28, 28, 32, 0.1)',
    actionButtonSecondaryBackground: 'rgba(28, 28, 32, 0.06)',
    closeButton: '#6a6a70',
    closeButtonBackground: 'rgba(28, 28, 32, 0.06)',
    connectButtonBackground: 'rgba(255, 255, 255, 0.72)',
    connectButtonInnerBackground: 'rgba(255, 255, 255, 0.6)',
    connectButtonText: '#1c1c20',
    connectionIndicator: '#30d158',
    error: '#ff453a',
    generalBorder: 'rgba(28, 28, 32, 0.1)',
    generalBorderDim: 'rgba(28, 28, 32, 0.06)',
    menuItemBackground: 'rgba(10, 132, 255, 0.06)',
    modalBackdrop: 'rgba(58, 45, 107, 0.25)',
    modalBackground: 'rgba(255, 255, 255, 0.94)',
    modalBorder: 'rgba(255, 255, 255, 0.18)',
    modalText: '#1c1c20',
    modalTextDim: '#6a6a70',
    modalTextSecondary: '#6a6a70',
    profileAction: 'rgba(255, 255, 255, 0.6)',
    profileActionHover: 'rgba(10, 132, 255, 0.06)',
    profileForeground: 'rgba(255, 255, 255, 0.72)',
    selectedOptionBorder: '#0a84ff',
    standby: '#ff9f0a',
  },
  fonts: { body: '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif' },
  radii: {
    actionButton: '8px',
    connectButton: '999px',
    menuButton: '8px',
    modal: '12px',
    modalMobile: '12px',
  },
  shadows: {
    ...base.shadows,
    dialog: '0 10px 40px rgba(0, 0, 0, 0.25)',
    connectButton: '0 2px 8px rgba(28, 28, 32, 0.08)',
    profileDetailsAction: 'none',
    selectedOption: 'none',
    selectedWallet: 'none',
    walletLogo: 'none',
  },
  blurs: { modalOverlay: 'blur(32px) saturate(180%)' },
};
