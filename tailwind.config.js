/**
 * Laptops and desktops (mouse or trackpad) use the desktop design from 768px wide; the signed-in app and the sign-in
 * screen are drawn at the design size and scaled to the window (src/hooks/useDesignScale.ts, AuthLayout). Touch tablets
 * and phones switch layouts at the usual widths. Keep in sync with DESKTOP_QUERY in src/hooks/useDesignScale.ts.
 */
const DESKTOP = '(min-width: 768px) and (hover: hover) and (pointer: fine)';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    screens: {
      sm: '640px',
      md: '768px',
      lg: { raw: `(min-width: 1024px), ${DESKTOP}` },
      xl: { raw: `(min-width: 1280px), ${DESKTOP}` },
      '2xl': '1536px',
    },
    extend: {
      colors: {
        // WorkEasy360 Booking green (buttons, active navigation, positive values).
        primary: {
          DEFAULT: '#16A34A',
          dark: '#15803D',
          light: '#E8F7EE',
        },
        // Deep green of the navigation and the sign-in hero.
        navy: {
          DEFAULT: '#0B3D35',
          light: '#0F5A47',
        },
        accent: '#FFC940',
        surface: '#FFFFFF',
        background: '#F5F7FA',
        border: '#E4E9EF',
        muted: '#F1F5F4',
        text: {
          primary: '#111827',
          secondary: '#4B5563',
          muted: '#8A94A3',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Poppins', 'Inter', 'system-ui', 'sans-serif'],
        // Typeface of the sign-in artwork.
        jakarta: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '8px',
        lg: '10px',
        xl: '14px',
        '2xl': '18px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.04), 0 2px 8px rgba(16,24,40,0.05)',
        dropdown: '0 8px 24px rgba(16,24,40,0.12)',
        modal: '0 12px 40px rgba(16,24,40,0.18)',
        button: '0 2px 6px rgba(21,128,61,0.28)',
      },
      backgroundImage: {
        'brand-button': 'linear-gradient(180deg, #1DAA4E 0%, #13893A 100%)',
        'brand-sidebar': 'linear-gradient(165deg, #0A3530 0%, #0B4239 45%, #0E5848 100%)',
        'brand-active': 'linear-gradient(180deg, #1FAE50 0%, #169A43 100%)',
      },
    },
  },
  plugins: [],
}
