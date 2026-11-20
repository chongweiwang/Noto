// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VaultSwitcher } from "./vault-switcher";

afterEach(cleanup);

it("知识库选项支持打开、创建、外部关闭和 Escape 返回焦点", () => {
  const onOpen = vi.fn(), onCreate = vi.fn();
  render(<VaultSwitcher vault={"\\\\?\\D:\\notes\\工作库"} web={false} busy={false} onOpen={onOpen} onCreate={onCreate} />);
  const trigger = screen.getByRole("button", { name: /知识库选项/ });
  expect(trigger.textContent).toContain("工作库");
  expect(trigger.getAttribute("aria-label")).toBe("知识库选项：工作库");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const open = screen.getByRole("button", { name: "打开其他知识库" });
  open.focus(); fireEvent.keyDown(open, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "知识库操作" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger); fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("group", { name: "知识库操作" })).toBeNull();
  fireEvent.click(trigger); fireEvent.click(screen.getByRole("button", { name: "打开其他知识库" }));
  expect(onOpen).toHaveBeenCalledOnce();
  fireEvent.click(trigger); fireEvent.click(screen.getByRole("button", { name: "新建知识库" }));
  expect(onCreate).toHaveBeenCalledOnce();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("网页或处理期间不提供本地知识库菜单", () => {
  const props = { vault: "网页库", onOpen: vi.fn(), onCreate: vi.fn() };
  const view = render(<VaultSwitcher {...props} web busy={false} />);
  expect((screen.getByRole("button", { name: /知识库选项/ }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<VaultSwitcher {...props} web={false} busy />);
  expect((screen.getByRole("button", { name: /知识库选项/ }) as HTMLButtonElement).disabled).toBe(true);
});
