"use client";

import { useId } from "react";

export default function FormField({ 
  label, 
  type = "text", 
  error, 
  helpText, 
  ...props 
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const helpTextId = `${id}-help`;
  
  const ariaDescribedBy = [
    error ? errorId : null,
    helpText ? helpTextId : null
  ].filter(Boolean).join(" ") || undefined;

  return (
    <div className="mb-5 flex flex-col">
      <label htmlFor={id} className="block text-sm font-medium mb-2 text-gray-900">
        {label}
      </label>
      <input
        type={type}
        className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-blue-600 ${error ? 'border-red-500' : 'border-gray-300'}`}
        {...props}
        id={id}
        aria-invalid={!!error}
        aria-describedby={ariaDescribedBy}
      />
      {helpText && !error && <p id={helpTextId} className="mt-1 text-xs text-gray-500">{helpText}</p>}
      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}