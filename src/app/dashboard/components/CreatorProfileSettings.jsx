"use client";

import { useState } from "react";
import {
  FaCheckCircle,
  FaExclamationTriangle,
  FaUser,
  FaSave,
} from "react-icons/fa";
import { useUpdateProfile } from "@/hooks/api/useProfile";

function validate(form) {
  const errors = {};

  if (!form.displayName || !form.displayName.trim()) {
    errors.displayName = "Display name is required";
  }

  if (form.displayName && form.displayName.length > 120) {
    errors.displayName = "Display name must be 120 characters or fewer";
  }

  if (form.bio && form.bio.length > 1000) {
    errors.bio = "Bio must be 1000 characters or fewer";
  }

  if (form.institution && form.institution.length > 160) {
    errors.institution = "Institution must be 160 characters or fewer";
  }

  if (form.country && form.country.length > 80) {
    errors.country = "Country must be 80 characters or fewer";
  }

  return errors;
}

function createInitialForm(initialUser) {
  return {
    displayName: initialUser?.fullName || "",
    bio: initialUser?.bio || "",
    institution: initialUser?.institution || "",
    country: initialUser?.country || "",
    twitterUrl: initialUser?.twitterUrl || "",
    githubUrl: initialUser?.githubUrl || "",
    websiteUrl: initialUser?.websiteUrl || "",
  };
}

function CreatorProfileSettingsForm({ initialUser }) {
  const { mutateAsync: updateProfile, isPending } = useUpdateProfile();

  const [form, setForm] = useState(() => createInitialForm(initialUser));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const validationErrors = validate(form);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    try {
      const payload = {};

      if (form.displayName.trim()) {
        payload.displayName = form.displayName.trim();
      }

      if (form.bio.trim()) {
        payload.bio = form.bio.trim();
      }

      if (form.institution.trim()) {
        payload.institution = form.institution.trim();
      }

      if (form.country.trim()) {
        payload.country = form.country.trim();
      }

      if (form.twitterUrl.trim()) {
        payload.twitterUrl = form.twitterUrl.trim();
      }

      if (form.githubUrl.trim()) {
        payload.githubUrl = form.githubUrl.trim();
      }

      if (form.websiteUrl.trim()) {
        payload.websiteUrl = form.websiteUrl.trim();
      }

      await updateProfile(payload);
      setSuccess("Profile settings saved.");
    } catch (err) {
      setError(err?.message || "Unable to save profile settings.");
    }
  };

  const set = (field) => (event) => {
    const value = event.target.value;

    setForm((current) => ({
      ...current,
      [field]: value,
    }));

    if (errors[field]) {
      setErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
            <FaUser />
            Creator profile
          </div>

          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
            Update your public profile details.
          </h1>

          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            Changes are saved instantly and visible on your public creator page.
          </p>
        </div>
      </div>

      {error ? (
        <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <FaExclamationTriangle className="mr-2 inline-block" />
          {error}
        </div>
      ) : null}

      {success ? (
        <div className="mb-6 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <FaCheckCircle className="mr-2 inline-block" />
          {success}
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <div className="grid gap-5 md:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">
              Display name <span className="text-red-500">*</span>
            </span>

            <input
              type="text"
              value={form.displayName}
              onChange={set("displayName")}
              placeholder="Your public name"
              className={`w-full rounded-2xl border bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:bg-white ${
                errors.displayName
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-200 focus:border-slate-400"
              }`}
              aria-invalid={Boolean(errors.displayName)}
            />

            {errors.displayName ? (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {errors.displayName}
              </p>
            ) : (
              <span className="mt-1 block text-xs text-slate-500">
                Required. Shown on your profile and material cards.
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">
              Institution
            </span>

            <input
              type="text"
              value={form.institution}
              onChange={set("institution")}
              placeholder="e.g. University of Lagos"
              className={`w-full rounded-2xl border bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:bg-white ${
                errors.institution
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-200 focus:border-slate-400"
              }`}
              aria-invalid={Boolean(errors.institution)}
            />

            {errors.institution ? (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {errors.institution}
              </p>
            ) : null}
          </label>
        </div>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">
            Bio
          </span>

          <textarea
            rows={4}
            value={form.bio}
            onChange={set("bio")}
            placeholder="Tell the community about yourself and your work..."
            className={`w-full rounded-2xl border bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:bg-white ${
              errors.bio
                ? "border-red-400 focus:border-red-500"
                : "border-slate-200 focus:border-slate-400"
            }`}
            aria-invalid={Boolean(errors.bio)}
          />

          {errors.bio ? (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {errors.bio}
            </p>
          ) : (
            <span className="mt-1 block text-xs text-slate-500">
              Maximum 1000 characters.
            </span>
          )}
        </label>

        <div className="grid gap-5 md:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">
              Country
            </span>

            <input
              type="text"
              value={form.country}
              onChange={set("country")}
              placeholder="e.g. Nigeria"
              className={`w-full rounded-2xl border bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:bg-white ${
                errors.country
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-200 focus:border-slate-400"
              }`}
              aria-invalid={Boolean(errors.country)}
            />

            {errors.country ? (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {errors.country}
              </p>
            ) : null}
          </label>
        </div>

        <fieldset>
          <legend className="mb-4 text-sm font-semibold text-slate-700">
            Social links
          </legend>

          <div className="grid gap-5 md:grid-cols-3">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-500">
                Twitter / X
              </span>

              <input
                type="url"
                value={form.twitterUrl}
                onChange={set("twitterUrl")}
                placeholder="https://x.com/username"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-500">
                GitHub
              </span>

              <input
                type="url"
                value={form.githubUrl}
                onChange={set("githubUrl")}
                placeholder="https://github.com/username"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-500">
                Website
              </span>

              <input
                type="url"
                value={form.websiteUrl}
                onChange={set("websiteUrl")}
                placeholder="https://example.com"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white"
              />
            </label>
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FaSave />
            {isPending ? "Saving..." : "Save profile"}
          </button>
        </div>
      </form>
    </section>
  );
}

export default function CreatorProfileSettings({ initialUser }) {
  const formKey = [
    initialUser?._id || initialUser?.id || "creator-profile",
    initialUser?.fullName || "",
    initialUser?.bio || "",
    initialUser?.institution || "",
    initialUser?.country || "",
    initialUser?.twitterUrl || "",
    initialUser?.githubUrl || "",
    initialUser?.websiteUrl || "",
  ].join("|");

  return (
    <CreatorProfileSettingsForm
      key={formKey}
      initialUser={initialUser}
    />
  );
}