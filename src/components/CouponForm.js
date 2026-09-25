"use client";

import { useState } from "react";
import { FaPercent, FaPlus } from "react-icons/fa";
import { useToast } from "@/hooks/useToast";

const initialValues = { code: "", discountPercent: "", expiresAt: "", maxRedemptions: "" };

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function CouponForm({ onCreated }) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const toast = useToast();

  function validate() {
    const next = {};
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(values.code.trim())) next.code = "Use 3–32 letters, numbers, hyphens, or underscores.";
    const discount = Number(values.discountPercent);
    if (!Number.isInteger(discount) || discount < 1 || discount > 100) next.discountPercent = "Enter a whole number from 1 to 100.";
    if (!values.expiresAt || values.expiresAt <= today()) next.expiresAt = "Choose a date after today.";
    const redemptions = Number(values.maxRedemptions);
    if (!Number.isInteger(redemptions) || redemptions < 1) next.maxRedemptions = "Enter at least one redemption.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validate()) return;
    setIsSaving(true);
    try {
      const response = await fetch("/api/creator/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: values.code.trim().toUpperCase(),
          discountPercent: Number(values.discountPercent),
          expiresAt: values.expiresAt,
          maxRedemptions: Number(values.maxRedemptions),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to create the coupon.");
      onCreated(data.coupon);
      setValues(initialValues);
      toast.showToast({ type: "success", title: "Coupon created", message: `${data.coupon.code} is ready to share.` });
    } catch (error) {
      toast.showToast({ type: "error", title: "Coupon not created", message: error.message });
    } finally {
      setIsSaving(false);
    }
  }

  const fieldClass = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
  return <form onSubmit={handleSubmit} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
    <div className="mb-5 flex items-center gap-3"><span className="rounded-xl bg-blue-50 p-3 text-blue-600"><FaPercent /></span><div><h2 className="font-semibold text-gray-900">Create a coupon</h2><p className="text-sm text-gray-500">Give learners a limited-time percentage discount.</p></div></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Code ID" error={errors.code}><input value={values.code} onChange={(e) => setValues({ ...values, code: e.target.value })} placeholder="WELCOME25" className={fieldClass} aria-invalid={Boolean(errors.code)} /></Field>
      <Field label="Percentage discount" error={errors.discountPercent}><input type="number" min="1" max="100" step="1" value={values.discountPercent} onChange={(e) => setValues({ ...values, discountPercent: e.target.value })} placeholder="25" className={fieldClass} aria-invalid={Boolean(errors.discountPercent)} /></Field>
      <Field label="Expiration date" error={errors.expiresAt}><input type="date" min={today()} value={values.expiresAt} onChange={(e) => setValues({ ...values, expiresAt: e.target.value })} className={fieldClass} aria-invalid={Boolean(errors.expiresAt)} /></Field>
      <Field label="Maximum redemptions" error={errors.maxRedemptions}><input type="number" min="1" step="1" value={values.maxRedemptions} onChange={(e) => setValues({ ...values, maxRedemptions: e.target.value })} placeholder="100" className={fieldClass} aria-invalid={Boolean(errors.maxRedemptions)} /></Field>
    </div>
    <button type="submit" disabled={isSaving} className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"><FaPlus />{isSaving ? "Creating…" : "Create coupon"}</button>
  </form>;
}

function Field({ label, error, children }) { return <label className="block text-sm font-medium text-gray-700">{label}{children}{error && <span className="mt-1 block text-xs text-red-600">{error}</span>}</label>; }
