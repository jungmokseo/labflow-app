import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0f',
        'bg-card': '#1a1a2e',
        'bg-input': '#2a2a4a',
        primary: '#6C63FF',
        'primary-hover': '#5a52e0',
        accent: '#4ade80',
        'text-main': '#e0e0e0',
        'text-muted': '#888',
      },
    },
  },
  plugins: [],
};
export default config;
