"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  FiArrowRight,
  FiBarChart2,
  FiBookOpen,
  FiCheck,
  FiClipboard,
  FiFileText,
  FiLayers,
  FiMail,
  FiShield,
  FiUsers,
} from "react-icons/fi";
import Footer from "@/components/Footer";
import Navbar from "@/components/Navbar";

const institutionTypes = [
  "University",
  "Secondary school",
  "Professional academy",
  "Bootcamp or cohort",
  "Research institute",
  "Other academic team",
];

const featureCards = [
  {
    icon: FiLayers,
    title: "Bulk Material Purchasing",
    description:
      "License reading packs, exam prep, lab templates, and faculty-created resources for full departments or cohorts.",
  },
  {
    icon: FiShield,
    title: "Institution-Level Discounts",
    description:
      "Align spend to learner volume with predictable pricing, quote-ready packages, and renewal-friendly terms.",
  },
  {
    icon: FiUsers,
    title: "Cohort Management",
    description:
      "Organize access by class, intake, or program so students only see the materials assigned to their learning path.",
  },
  {
    icon: FiClipboard,
    title: "Procurement Workflows",
    description:
      "Support academic buyers with approvals, invoice references, purchase summaries, and clear audit trails.",
  },
  {
    icon: FiBarChart2,
    title: "Usage Visibility",
    description:
      "Track adoption signals across purchased materials to understand which resources support learning outcomes.",
  },
  {
    icon: FiMail,
    title: "Academic Team Support",
    description:
      "Get guided onboarding for administrators, lecturers, program managers, and student support teams.",
  },
];

const workflowSteps = [
  "Map departments, cohorts, and learner volume",
  "Select material bundles and licensing terms",
  "Approve one institutional purchase",
  "Monitor access, renewals, and usage signals",
];

const initialForm = {
  contactName: "",
  email: "",
  institutionName: "",
  institutionType: "",
  learnerCount: "",
  message: "",
  consent: false,
};

function validateLead(form) {
  const errors = {};
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const trimmedMessage = form.message.trim();
  const learnerCount = Number(form.learnerCount);

  if (!form.contactName.trim()) {
    errors.contactName = "Enter a contact name.";
  }

  if (!form.email.trim()) {
    errors.email = "Enter a work email.";
  } else if (!emailPattern.test(form.email.trim())) {
    errors.email = "Enter a valid email address.";
  }

  if (!form.institutionName.trim()) {
    errors.institutionName = "Enter the institution name.";
  }

  if (!form.institutionType) {
    errors.institutionType = "Select an institution type.";
  }

  if (!form.learnerCount.trim()) {
    errors.learnerCount = "Enter the number of learners.";
  } else if (
    !Number.isInteger(learnerCount) ||
    learnerCount <= 0 ||
    learnerCount > 1000000
  ) {
    errors.learnerCount = "Enter a whole number greater than 0.";
  }

  if (!trimmedMessage) {
    errors.message = "Tell us what materials you need.";
  } else if (trimmedMessage.length < 20) {
    errors.message = "Use at least 20 characters.";
  } else if (trimmedMessage.length > 800) {
    errors.message = "Keep the message under 800 characters.";
  }

  if (!form.consent) {
    errors.consent = "Confirm that EduVault may contact you.";
  }

  return errors;
}

function FieldError({ id, message }) {
  if (!message) return null;

  return (
    <p id={id} role="alert" className="mt-2 text-sm font-semibold text-red-600">
      {message}
    </p>
  );
}

export default function InstitutionsPage() {
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [submitState, setSubmitState] = useState("idle");

  const mailtoHref = useMemo(() => {
    const subject = encodeURIComponent(
      `Institution partnership inquiry: ${form.institutionName || "EduVault"}`
    );
    const body = encodeURIComponent(
      [
        `Contact name: ${form.contactName}`,
        `Work email: ${form.email}`,
        `Institution: ${form.institutionName}`,
        `Institution type: ${form.institutionType}`,
        `Learners: ${form.learnerCount}`,
        "",
        "Materials needed:",
        form.message,
      ].join("\n")
    );

    return `mailto:partnerships@eduvault.app?subject=${subject}&body=${body}`;
  }, [form]);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSubmitState("idle");
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const nextErrors = validateLead(form);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      setSubmitState("error");
      return;
    }

    setSubmitState("success");
  };

  return (
    <main className="min-h-screen overflow-x-hidden bg-white text-stellar-dark">
      <Navbar />

      <section className="relative overflow-hidden bg-[linear-gradient(135deg,#f8fbff_0%,#ffffff_42%,#f6fffc_100%)] px-6 pb-20 pt-32 md:px-12 lg:px-16 lg:pb-24">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-stellar-blue/40 to-transparent" />
        <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.02fr_0.98fr]">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-stellar-blue/15 bg-white px-4 py-2 text-sm font-bold text-stellar-blue shadow-sm">
              <FiBookOpen aria-hidden="true" />
              Institutional access for academic teams
            </div>
            <h1 className="max-w-4xl text-4xl font-black leading-tight text-stellar-dark md:text-6xl">
              Equip every learner with verified educational materials.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-edu-muted md:text-xl">
              EduVault helps schools, universities, and cohort managers buy
              trusted academic resources in bulk, distribute them cleanly, and
              keep procurement visible.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a
                href="#institution-lead-form"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-stellar-blue px-7 py-3 text-base font-bold text-white shadow-lg shadow-stellar-blue/20 transition hover:bg-stellar-blue/90"
              >
                Request institution pricing
                <FiArrowRight aria-hidden="true" />
              </a>
              <Link
                href="/marketplace"
                className="inline-flex min-h-12 items-center justify-center rounded-lg border border-edu-border bg-white px-7 py-3 text-base font-bold text-stellar-dark transition hover:border-stellar-blue/40 hover:text-stellar-blue"
              >
                Browse materials
              </Link>
            </div>

            <dl className="mt-12 grid max-w-2xl grid-cols-3 gap-4 border-y border-edu-border py-6">
              <div>
                <dt className="text-sm font-semibold text-edu-muted">
                  Buyer type
                </dt>
                <dd className="mt-1 text-lg font-black">B2B</dd>
              </div>
              <div>
                <dt className="text-sm font-semibold text-edu-muted">
                  Best for
                </dt>
                <dd className="mt-1 text-lg font-black">Cohorts</dd>
              </div>
              <div>
                <dt className="text-sm font-semibold text-edu-muted">
                  Support
                </dt>
                <dd className="mt-1 text-lg font-black">Guided</dd>
              </div>
            </dl>
          </div>

          <div className="relative">
            <div className="overflow-hidden rounded-lg border border-white/70 bg-white shadow-2xl shadow-stellar-dark/10">
              <div className="relative aspect-[4/3] min-h-[320px]">
                <Image
                  src="/hero-stellar.png"
                  alt="EduVault academic materials dashboard preview"
                  fill
                  priority
                  sizes="(min-width: 1024px) 45vw, 100vw"
                  className="object-cover"
                />
              </div>
              <div className="grid gap-0 border-t border-edu-border bg-white md:grid-cols-3">
                {["Bulk quotes", "Class access", "Usage reports"].map((item) => (
                  <div
                    key={item}
                    className="flex items-center gap-2 border-b border-edu-border px-5 py-4 text-sm font-bold text-stellar-dark md:border-b-0 md:border-r last:md:border-r-0"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-teal/10 text-accent-teal">
                      <FiCheck aria-hidden="true" />
                    </span>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-16 md:px-12 lg:px-16">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="text-sm font-black uppercase text-accent-teal">
              Built for academic procurement
            </p>
            <h2 className="mt-3 text-3xl font-black leading-tight md:text-5xl">
              Bulk licensing, administrative control, and clear rollout paths.
            </h2>
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {featureCards.map(({ icon: Icon, title, description }) => (
              <article
                key={title}
                className="rounded-lg border border-edu-border bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-stellar-blue/30 hover:shadow-xl hover:shadow-stellar-blue/5"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-stellar-blue/10 text-stellar-blue">
                  <Icon aria-hidden="true" className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-xl font-black">{title}</h3>
                <p className="mt-3 text-base leading-7 text-edu-muted">
                  {description}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-stellar-dark px-6 py-20 text-white md:px-12 lg:px-16">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p className="text-sm font-black uppercase text-accent-teal">
              Administrative tools
            </p>
            <h2 className="mt-3 text-3xl font-black leading-tight md:text-5xl">
              Move from scattered purchases to one institution-ready workflow.
            </h2>
            <p className="mt-5 text-lg leading-8 text-gray-300">
              EduVault keeps academic teams aligned across procurement,
              classroom distribution, and visibility into material adoption.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {workflowSteps.map((step, index) => (
              <div
                key={step}
                className="rounded-lg border border-white/10 bg-white/[0.06] p-6"
              >
                <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-lg bg-white text-stellar-dark text-sm font-black">
                  {index + 1}
                </div>
                <p className="text-lg font-bold leading-7">{step}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-20 md:px-12 lg:px-16">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.88fr_1.12fr] lg:items-start">
          <div className="lg:sticky lg:top-28">
            <p className="text-sm font-black uppercase text-stellar-blue">
              Institution lead intake
            </p>
            <h2 className="mt-3 text-3xl font-black leading-tight md:text-5xl">
              Tell us what your academic team needs.
            </h2>
            <p className="mt-5 text-lg leading-8 text-edu-muted">
              Share your learner volume, material needs, and purchasing context.
              If the form validates, EduVault prepares a prefilled email so your
              team can send the inquiry from an approved work inbox.
            </p>
            <div className="mt-8 rounded-lg border border-edu-border bg-edu-light p-5">
              <div className="flex items-start gap-3">
                <FiFileText
                  aria-hidden="true"
                  className="mt-1 h-5 w-5 shrink-0 text-accent-teal"
                />
                <p className="text-sm leading-6 text-edu-muted">
                  No backend lead storage is added here. The safe fallback is a
                  validated frontend submission state with a prefilled email
                  handoff.
                </p>
              </div>
            </div>
          </div>

          <form
            id="institution-lead-form"
            onSubmit={handleSubmit}
            noValidate
            className="rounded-lg border border-edu-border bg-white p-5 shadow-xl shadow-stellar-dark/5 md:p-8"
          >
            <div
              className="mb-6 rounded-lg border border-stellar-blue/15 bg-stellar-blue/5 px-4 py-3 text-sm font-semibold text-stellar-dark"
              aria-live="polite"
            >
              {submitState === "success"
                ? "Validation passed. Use the email handoff below to send your inquiry."
                : submitState === "error"
                  ? "Please fix the highlighted fields before submitting."
                  : "All fields are required unless noted."}
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label
                  htmlFor="contactName"
                  className="block text-sm font-bold text-stellar-dark"
                >
                  Contact name
                </label>
                <input
                  id="contactName"
                  value={form.contactName}
                  onChange={(event) =>
                    updateField("contactName", event.target.value)
                  }
                  aria-invalid={!!errors.contactName}
                  aria-describedby={
                    errors.contactName ? "contactName-error" : undefined
                  }
                  className="mt-2 min-h-12 w-full rounded-lg border border-edu-border px-4 text-base outline-none transition focus:border-stellar-blue focus:ring-4 focus:ring-stellar-blue/10"
                />
                <FieldError
                  id="contactName-error"
                  message={errors.contactName}
                />
              </div>

              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-bold text-stellar-dark"
                >
                  Work email
                </label>
                <input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(event) => updateField("email", event.target.value)}
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? "email-error" : undefined}
                  className="mt-2 min-h-12 w-full rounded-lg border border-edu-border px-4 text-base outline-none transition focus:border-stellar-blue focus:ring-4 focus:ring-stellar-blue/10"
                />
                <FieldError id="email-error" message={errors.email} />
              </div>

              <div>
                <label
                  htmlFor="institutionName"
                  className="block text-sm font-bold text-stellar-dark"
                >
                  Institution name
                </label>
                <input
                  id="institutionName"
                  value={form.institutionName}
                  onChange={(event) =>
                    updateField("institutionName", event.target.value)
                  }
                  aria-invalid={!!errors.institutionName}
                  aria-describedby={
                    errors.institutionName
                      ? "institutionName-error"
                      : undefined
                  }
                  className="mt-2 min-h-12 w-full rounded-lg border border-edu-border px-4 text-base outline-none transition focus:border-stellar-blue focus:ring-4 focus:ring-stellar-blue/10"
                />
                <FieldError
                  id="institutionName-error"
                  message={errors.institutionName}
                />
              </div>

              <div>
                <label
                  htmlFor="institutionType"
                  className="block text-sm font-bold text-stellar-dark"
                >
                  Institution type
                </label>
                <select
                  id="institutionType"
                  value={form.institutionType}
                  onChange={(event) =>
                    updateField("institutionType", event.target.value)
                  }
                  aria-invalid={!!errors.institutionType}
                  aria-describedby={
                    errors.institutionType
                      ? "institutionType-error"
                      : undefined
                  }
                  className="mt-2 min-h-12 w-full rounded-lg border border-edu-border bg-white px-4 text-base outline-none transition focus:border-stellar-blue focus:ring-4 focus:ring-stellar-blue/10"
                >
                  <option value="">Select type</option>
                  {institutionTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <FieldError
                  id="institutionType-error"
                  message={errors.institutionType}
                />
              </div>

              <div className="md:col-span-2">
                <label
                  htmlFor="learnerCount"
                  className="block text-sm font-bold text-stellar-dark"
                >
                  Number of learners or students
                </label>
                <input
                  id="learnerCount"
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={form.learnerCount}
                  onChange={(event) =>
                    updateField("learnerCount", event.target.value)
                  }
                  aria-invalid={!!errors.learnerCount}
                  aria-describedby={
                    errors.learnerCount ? "learnerCount-error" : undefined
                  }
                  className="mt-2 min-h-12 w-full rounded-lg border border-edu-border px-4 text-base outline-none transition focus:border-stellar-blue focus:ring-4 focus:ring-stellar-blue/10"
                />
                <FieldError
                  id="learnerCount-error"
                  message={errors.learnerCount}
                />
              </div>

              <div className="md:col-span-2">
                <div className="flex items-end justify-between gap-4">
                  <label
                    htmlFor="message"
                    className="block text-sm font-bold text-stellar-dark"
                  >
                    Materials needed
                  </label>
                  <span className="text-xs font-semibold text-edu-muted">
                    {form.message.length}/800
                  </span>
                </div>
                <textarea
                  id="message"
                  value={form.message}
                  maxLength={800}
                  rows={5}
                  onChange={(event) =>
                    updateField("message", event.target.value)
                  }
                  aria-invalid={!!errors.message}
                  aria-describedby={errors.message ? "message-error" : undefined}
                  className="mt-2 w-full resize-y rounded-lg border border-edu-border px-4 py-3 text-base outline-none transition focus:border-stellar-blue focus:ring-4 focus:ring-stellar-blue/10"
                />
                <FieldError id="message-error" message={errors.message} />
              </div>
            </div>

            <div className="mt-6">
              <label className="flex items-start gap-3 text-sm font-semibold leading-6 text-edu-muted">
                <input
                  type="checkbox"
                  checked={form.consent}
                  onChange={(event) =>
                    updateField("consent", event.target.checked)
                  }
                  aria-invalid={!!errors.consent}
                  aria-describedby={
                    errors.consent ? "consent-error" : undefined
                  }
                  className="mt-1 h-5 w-5 rounded border-edu-border text-stellar-blue focus:ring-stellar-blue"
                />
                EduVault may contact me about institutional pricing, academic
                support, and procurement options.
              </label>
              <FieldError id="consent-error" message={errors.consent} />
            </div>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="submit"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-stellar-dark px-7 py-3 text-base font-bold text-white transition hover:bg-stellar-dark/90"
              >
                Validate inquiry
                <FiCheck aria-hidden="true" />
              </button>
              {submitState === "success" && (
                <a
                  href={mailtoHref}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-stellar-blue bg-white px-7 py-3 text-base font-bold text-stellar-blue transition hover:bg-stellar-blue/5"
                >
                  Open email draft
                  <FiMail aria-hidden="true" />
                </a>
              )}
            </div>
          </form>
        </div>
      </section>

      <Footer />
    </main>
  );
}
