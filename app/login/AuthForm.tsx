'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { signIn, signUp, type FormState } from '../actions/auth.ts';
import { Button, ErrorNote, Field, inputClass } from '../components/ui.tsx';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Just a moment…' : label}
    </Button>
  );
}

export function AuthForm({ initialMode }: { initialMode: 'signin' | 'signup' }) {
  const [mode, setMode] = useState(initialMode);
  const action = mode === 'signup' ? signUp : signIn;
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="mb-4 flex gap-1 rounded-lg border border-line bg-panel-2 p-1">
        {(['signin', 'signup'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
              mode === option ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'
            }`}
          >
            {option === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>

      {/* Remounting on mode change clears the other mode's stale error. */}
      <form key={mode} action={formAction} className="flex flex-col gap-3">
        <Field label="Username">
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            required
            className={inputClass}
            placeholder="ash"
          />
        </Field>

        {mode === 'signup' && (
          <Field label="Display name" hint="What the rest of the league sees.">
            <input name="displayName" className={inputClass} placeholder="Ash Ketchum" />
          </Field>
        )}

        <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
          <input
            name="password"
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            className={inputClass}
          />
        </Field>

        <ErrorNote>{state.error}</ErrorNote>
        <Submit label={mode === 'signup' ? 'Create account' : 'Sign in'} />
      </form>
    </div>
  );
}
