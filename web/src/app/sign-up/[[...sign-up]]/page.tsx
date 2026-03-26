'use client';

import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-4">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-white mb-2">
          🧪 <span className="text-primary">LabFlow</span>
        </h1>
        <p className="text-text-muted text-sm">Research Lab AI OS</p>
      </div>
      <SignUp
        appearance={{
          elements: {
            rootBox: 'mx-auto',
            card: 'bg-bg-card border border-bg-input/50 shadow-xl',
            headerTitle: 'text-white',
            headerSubtitle: 'text-text-muted',
            socialButtonsBlockButton: 'bg-bg-input border-bg-input/50 text-white hover:bg-bg-input/80',
            formFieldLabel: 'text-text-muted',
            formFieldInput: 'bg-bg-input border-bg-input/50 text-white',
            footerActionLink: 'text-primary hover:text-primary-hover',
            formButtonPrimary: 'bg-primary hover:bg-primary-hover',
          },
        }}
        afterSignUpUrl="/"
        signInUrl="/sign-in"
      />
    </div>
  );
}
