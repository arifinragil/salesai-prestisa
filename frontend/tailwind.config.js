/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,jsx,ts,tsx}',
    './src/components/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      screens: {
        xs: '420px',
      },
      colors: {
        brand: {
          50:  '#e6fff7',
          100: '#b3ffe6',
          500: '#00aa77',
          600: '#009966',
          700: '#007a52',
        },
      },
    },
  },
  plugins: [],
};
