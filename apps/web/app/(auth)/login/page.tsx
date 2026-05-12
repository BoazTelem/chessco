import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { LoginForm } from './login-form';

export const metadata = {
  title: 'Sign in',
};

export default async function LoginPage() {
  const user = await getUser();
  if (user) redirect('/dashboard');

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we&apos;ll send you a magic link.
        </p>
      </div>

      <LoginForm />

      <p className="text-center text-sm text-muted-foreground">
        New to Chessco?{' '}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
