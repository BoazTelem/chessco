import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { GoogleButton } from '../google-button';
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

      <GoogleButton label="Continue with Google" />

      <Divider />

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

function Divider() {
  return (
    <div className="relative">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-background px-3 text-xs uppercase tracking-wider text-muted-foreground">
          or with email
        </span>
      </div>
    </div>
  );
}
