import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssignmentWorkspace } from "../src/pages/Assignments";
import Bookings from "../src/pages/Bookings";
import { AttachmentRow } from "../src/components/ui";
const env = (data: unknown) => ({
  data,
  updatedAt: new Date().toISOString(),
  generation: "test",
  error: null,
  warnings: [],
  stale: false,
});
function mount(node: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("filters assignments with the same categories as the Android app", async () => {
  const base = {
    course_name: "测试课",
    course_id: "_1_1",
    content_id: "_2_1",
    deadline_raw: null,
    attachments: [],
    descriptions: [],
    detail_error: false,
    last_attempt: null,
    deadline: null,
  };
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () =>
        env([
          { ...base, hash_id: "a", title: "还没到的作业", deadline: future },
          {
            ...base,
            hash_id: "b",
            title: "交过的作业",
            deadline: past,
            last_attempt: "1 次",
          },
          { ...base, hash_id: "c", title: "过期的作业", deadline: past },
          { ...base, hash_id: "d", title: "暂未获取详情", detail_error: true },
        ]),
    })),
  );
  mount(<AssignmentWorkspace login={() => {}} />);
  // 默认停在「待交」；没有截止时间的作业也按待交处理，与安卓端一致。
  await screen.findByRole("button", { name: /暂未获取详情/ });
  expect(
    screen.getByRole("button", { name: /还没到的作业/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /交过的作业/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /过期的作业/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "已提交" }));
  expect(
    screen.getAllByRole("button", { name: /交过的作业/ }).length,
  ).toBeGreaterThan(0);
  expect(
    screen.queryByRole("button", { name: /还没到的作业/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "已截止" }));
  expect(
    screen.getAllByRole("button", { name: /过期的作业/ }).length,
  ).toBeGreaterThan(0);
  expect(
    screen.queryByRole("button", { name: /交过的作业/ }),
  ).not.toBeInTheDocument();
  // 「全部」按最近截止排前面，读不到详情的仍然只标成「状态待核对」。
  fireEvent.click(screen.getByRole("tab", { name: "全部" }));
  const titles = [
    ...document.querySelectorAll(".assignment-choice strong"),
  ].map((el) => el.textContent);
  expect(titles[0]).toBe("还没到的作业");
  expect(
    screen.getByRole("button", { name: /暂未获取详情/ }),
  ).toHaveTextContent("状态待核对");
});
it("requests the reservation account without affecting teaching login", async () => {
  const login = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...env(null),
        error: { code: "auth", message: "请连接北大空间" },
      }),
    })),
  );
  mount(<Bookings login={login} />);
  fireEvent.click(
    screen.getByRole("button", { name: "教学研讨", exact: true }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "重新登录", exact: true }),
  );
  expect(login.mock.calls[0][0]).toBe("bdkj");
  expect(
    screen.getByRole("button", { name: "体育场馆", exact: true }),
  ).toBeEnabled();
});
it("shows the profile prerequisite without asking for another login", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...env(null),
        error: {
          code: "bookingProfile",
          message: "学校要求先完善联系电话和联系邮箱，完成后即可重新查询时段",
        },
      }),
    })),
  );
  mount(<Bookings login={() => {}} />);
  expect(
    await screen.findByRole("button", { name: "完善预约资料" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "重新登录" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});
