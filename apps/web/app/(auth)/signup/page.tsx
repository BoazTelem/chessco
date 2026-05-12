import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { GoogleButton } from '../google-button';
import { SignupForm } from './signup-form';

export const metadata = {
  title: 'Create account',
};

export default async function SignupPage() {
  const user = await getUser();
  if (user) redirect('/dashboard');

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground">
          Free to start. No credit card. You can link a Lichess or Chess.com account next.
        </p>
      </div>

      <GoogleButton label="Sign up with Google" />

      <Divider />

      <SignupForm />

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
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
