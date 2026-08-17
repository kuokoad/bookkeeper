export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
