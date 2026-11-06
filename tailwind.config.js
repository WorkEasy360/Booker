/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#00BF62',
          dark: '#008F49',
          light: '#E6F9F0',
        },
        navy: {
          DEFAULT: '#13222E',
          light: '#1E3344',
        },
        accent: '#FFC940',
        surface: '#FFFFFF',
        background: '#F6F8F9',
        border: '#E1E7EB',
        muted: '#EEF3F2',
        text: {
          primary: '#17232D',
          secondary: '#667581',
          muted: '#94A3B0',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        dropdown: '0 4px 16px rgba(0,0,0,0.12)',
        modal: '0 8px 32px rgba(0,0,0,0.16)',
      },
    },
  },
  plugins: [],
}
