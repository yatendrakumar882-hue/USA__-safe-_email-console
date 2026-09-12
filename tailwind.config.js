/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        'bulk-bg': '#f8f9fc',
        'bulk-accent': '#6c5ce7',
        'bulk-success': '#00b894',
        'bulk-danger': '#d63031',
        'bulk-warning': '#f1c40f',
      },
    },
  },
  plugins: [],
}
