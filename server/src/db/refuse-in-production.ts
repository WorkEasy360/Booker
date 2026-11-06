// Imported before the database by scripts that create demo data (a demo business with a known admin password).
// With NODE_ENV=production they stop before the database file is even opened.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to create demo data with NODE_ENV=production.');
  process.exit(1);
}

export {};
