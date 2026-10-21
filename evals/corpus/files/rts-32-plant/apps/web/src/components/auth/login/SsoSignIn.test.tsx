import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as SsoSignIn from "./SsoSignIn";
import { SsoErrorNotice } from "./SsoSignIn";

describe("SsoErrorNotice", () => {
	it("renders nothing without an error code", () => {
		render(<SsoErrorNotice />);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("explains a known error code", () => {
		render(<SsoErrorNotice code="no_account" />);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"There is no Paca account for this identity.",
		);
	});

	it("falls back to a generic message for an unknown code", () => {
		const spy = vi.spyOn(SsoSignIn, "ssoErrorMessage");
		render(<SsoErrorNotice code="<script>" />);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith("<script>");
	});
});
