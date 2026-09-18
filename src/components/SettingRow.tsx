import type { ReactNode } from "react";

/** 设置页统一的一行：左边标签与一句说明，右边控件；状态或错误显示在整行下方。 */
export default function SettingRow({
  label,
  description,
  control,
  children,
  status,
  error,
  stacked = false,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** 右侧控件。 */
  control?: ReactNode;
  /** 占满整行的内容（表单、列表）。 */
  children?: ReactNode;
  status?: ReactNode;
  error?: ReactNode;
  /** 控件另起一行，用于宽表单。 */
  stacked?: boolean;
}) {
  return (
    <div className={`setting-row ${stacked ? "stacked" : ""}`}>
      <div className="setting-row-main">
        <div className="setting-row-text">
          <span className="setting-row-label">{label}</span>
          {description && (
            <span className="setting-row-description">{description}</span>
          )}
        </div>
        {control && <div className="setting-row-control">{control}</div>}
      </div>
      {children && <div className="setting-row-body">{children}</div>}
      {status && (
        <p role="status" className="setting-row-status">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="setting-row-status error">
          {error}
        </p>
      )}
    </div>
  );
}
