サンプルCSV（すべて架空。実在の会社・人物とは関係ない）
rentals_normal.csv         正常（2貸出・4明細）
rentals_fullwidth.csv      全角の原文保持（「株式会社ＡＢＣ」「Ｒ－１０１」「Ｒ－００１」）、UTF-8 BOM付き
rentals_long_names.csv     長名（顧客120字・品名160字）
rentals_formula.csv        =,+,-,@ で始まる文字列（CSV出力の無害化確認用）
rentals_error_one_row.csv  1行だけ全角数字 → 全体未確定
rentals_duplicate.csv      明細キーの重複
rentals_errors_many.csv    未知拠点・日時形式・負数・桁超過・空白のみ・空欄・前後空白（警告）
rentals_cp932.csv          Shift_JIS(CP932) → 拒否して CSV UTF-8 を案内
