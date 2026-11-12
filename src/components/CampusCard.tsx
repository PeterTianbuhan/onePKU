import { expiry, money } from "../lib/api";
import landscape from "../assets/campus-card-school.webp";

export type Card = {
  name: string;
  balance: number;
  lost: boolean;
  frozen: boolean;
  expires: string;
};

/** 校园卡的卡面：湖景做底，上面是余额、状态与有效期。 */
export default function CampusCard({ card }: { card: Card }) {
  return (
    <div className="campus-card-face">
      <img
        className="campus-card-art"
        src={landscape}
        alt=""
        aria-hidden="true"
      />
      <div className="campus-card-content">
        <div className="card-topline">
          <span className="balance-label">可用余额</span>
          <span
            className={`card-status ${card.lost || card.frozen ? "restricted" : ""}`}
          >
            {card.lost ? "已挂失" : card.frozen ? "已冻结" : "正常"}
          </span>
        </div>
        <div className="balance">
          <span>¥</span>
          {money(card.balance)}
        </div>
        {card.expires && (
          <span className="card-validity">有效期至 {expiry(card.expires)}</span>
        )}
      </div>
    </div>
  );
}
