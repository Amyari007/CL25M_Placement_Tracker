/** Design tokens for CL25M Placement Tracker. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#F7F6F3',
        surface: '#FFFFFF',
        line: { DEFAULT: '#E5E3DD', strong: '#D3D0C8' },
        ink: { DEFAULT: '#13213C', 700: '#24365A', 600: '#34496F', 50: '#EEF1F6' },
        muted: { DEFAULT: '#5B6578', light: '#8A92A3' },
        teal: { DEFAULT: '#0F766E', 700: '#0B5F58', 50: '#E7F3F1' },
        amber: { DEFAULT: '#B45309', 50: '#FDF3E4' },
        danger: { DEFAULT: '#B42318', 700: '#912018', 50: '#FDECEA' },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: { card: '12px', ctl: '8px' },
      boxShadow: {
        card: '0 1px 2px rgba(19,33,60,0.04), 0 1px 1px rgba(19,33,60,0.03)',
        pop: '0 12px 32px -8px rgba(19,33,60,0.18), 0 2px 6px rgba(19,33,60,0.06)',
      },
      fontSize: { '2xs': ['11px', '16px'] },
    },
  },
  plugins: [],
};
