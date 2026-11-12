import { expiry, money } from "../lib/api";
import landscape from "../assets/campus-card-school.webp";

export type Card = {
  name: string;
  balance: number;
  lost: boolean;
  frozen: boolean;
  expires: string;
};

/** 校园卡。校园卡页是带湖景的整张卡面；今日页的湖景在页头，这里只留数字（plain）。 */
export default function CampusCard({
  card,
  plain = false,
}: {
  card: Card;
  plain?: boolean;
}) {
  return (
    <div className={`campus-card-face ${plain ? "plain" : ""}`}>
      {!plain && (
        <img
          className="campus-card-art"
          src={landscape}
          alt=""
          aria-hidden="true"
        />
      )}
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
