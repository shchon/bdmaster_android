import React, { useMemo, useState } from 'react';
import { BondData } from '../types';
import { ArrowUp, ArrowDown, Filter, Star, ArrowUpCircle, ArrowDownCircle, ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  title: string;
  icon?: React.ReactNode;
  titleExtra?: React.ReactNode;
  data: BondData[];
  holdingIds: Set<string>;
  onToggleHolding: (id: string) => void;
  blacklistIds?: Set<string>;
  onAddToBlacklist?: (id: string) => void;
  buyIds?: Set<string>;
  onToggleBuy?: (id: string) => void;
  sellIds?: Set<string>;
  onToggleSell?: (id: string) => void;
  emptyMessage?: string;
  columnPreset?: 'default' | 'holdings' | 'market';
  showScoreColumns?: boolean;
  showRedeemColumn?: boolean;
  countOptions?: Array<number | 'ALL'>;
  selectedCount?: number | 'ALL';
  onSelectCount?: (n: number | 'ALL') => void;
  toolbar?: React.ReactNode;
  expandableColumns?: boolean;
}

const BondTable: React.FC<Props> = ({ 
  title, 
  icon, 
  titleExtra,
  data, 
  holdingIds, 
  onToggleHolding, 
  blacklistIds,
  onAddToBlacklist,
  buyIds,
  onToggleBuy,
  sellIds,
  onToggleSell,
  emptyMessage = "暂无数据",
  columnPreset = 'default',
  showScoreColumns = false,
  showRedeemColumn = false,
  countOptions,
  selectedCount,
  onSelectCount,
  toolbar,
  expandableColumns = false
}) => {
  const filteredData = data;
  const isHoldingsPreset = columnPreset === 'holdings';
  const isMarketPreset = columnPreset === 'market';
  const showHoldingColumn = !isMarketPreset;

  const [expanded, setExpanded] = useState(false);
  const showAllColumns = expandableColumns && expanded;

  const shouldShowExpandToggle = useMemo(() => {
    if (!expandableColumns) return false;
    return true;
  }, [expandableColumns]);

  const formatRedeemStatus = (val?: string) => {
    if (!val) return '';
    const normalized = val.replace(/\\\//g, '/');
    const left = normalized.split('|', 1)[0]?.trim();
    return left || normalized.trim();
  };

  const renderRedeemCell = (ongoingDays?: number | null) => {
    if (ongoingDays == null) {
      return <span className="text-xs text-slate-500">-</span>;
    }
    if (ongoingDays > 0) {
      return <span className="text-xs font-medium text-red-400">{ongoingDays}天</span>;
    }
    return <span className="text-xs text-slate-300">0天</span>;
  };

  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden flex flex-col h-full">
      <div className="px-4 py-5 border-b border-slate-700 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-900/30">
        <h2 className="text-lg font-bold text-white flex flex-wrap items-center gap-2">
          {icon}
          {title}
          {titleExtra}
          {countOptions && selectedCount !== undefined && onSelectCount ? (
            <span className="flex items-center gap-2">
              {countOptions.map((n) => (
                <button
                  key={String(n)}
                  onClick={() => onSelectCount(n)}
                  className={`text-xs font-normal px-2 py-0.5 rounded-full border transition-colors ${
                    selectedCount === n
                      ? 'bg-blue-600 text-white border-blue-500'
                      : 'bg-slate-700 text-slate-300 border-slate-600 hover:bg-slate-600'
                  }`}
                >
                  {n === 'ALL' ? '全部' : `${n}只`}
                </button>
              ))}
            </span>
          ) : (
            <span className="text-xs font-normal text-slate-400 bg-slate-700 px-2 py-0.5 rounded-full">{filteredData.length} 支</span>
          )}
        </h2>

        <div className="w-full sm:w-auto flex flex-wrap items-center gap-2">
          {toolbar}
          {shouldShowExpandToggle && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors flex items-center gap-1"
              title={expanded ? '收起隐藏列' : '展开显示隐藏列'}
            >
              {expanded ? <ChevronUp size={14} className="text-slate-300" /> : <ChevronDown size={14} className="text-slate-300" />}
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto flex-1 overscroll-x-contain [-webkit-overflow-scrolling:touch]">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-slate-400 uppercase bg-slate-900/50 sticky top-0 z-10 backdrop-blur-sm">
            <tr>
              {showHoldingColumn && (
                <th className="px-2 sm:px-3 py-2.5 sm:py-3 w-10 text-center">关注</th>
              )}
              {onToggleBuy && <th className="px-2 sm:px-3 py-2.5 sm:py-3 w-10 text-center">待买</th>}
              {onToggleSell && <th className="px-2 sm:px-3 py-2.5 sm:py-3 w-10 text-center">待卖</th>}
              <th className="px-2 sm:px-3 py-2.5 sm:py-3">可转债代码</th>
              <th className="px-2 sm:px-3 py-2.5 sm:py-3">可转债名字</th>
              <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right">收盘价</th>
              {isMarketPreset && (
                <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right whitespace-nowrap">正股价</th>
              )}
              <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right">涨幅</th>
              {isMarketPreset && (
                <>
                  <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right whitespace-nowrap">剩余年限</th>
                  <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-center whitespace-nowrap">评级</th>
                  {showAllColumns && (
                    <>
                      <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right whitespace-nowrap">溢价率</th>
                      <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right whitespace-nowrap">纯债溢价</th>
                      <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right whitespace-nowrap">YTM</th>
                      <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right whitespace-nowrap">规模</th>
                      <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right whitespace-nowrap">强赎价</th>
                    </>
                  )}
                  {showRedeemColumn && <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-center whitespace-nowrap">强赎</th>}
                  {showScoreColumns && <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right whitespace-nowrap">总分</th>}
                </>
              )}
              {!isHoldingsPreset && !isMarketPreset && (
                <>
                  <th className={`px-2 sm:px-3 py-2.5 sm:py-3 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>正股名字</th>
                  <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-right">溢价率</th>
                  {showScoreColumns && (
                    <th className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
                      纯债溢价率
                    </th>
                  )}
                  <th className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>剩余年限</th>
                  <th className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>换手率</th>
                  <th className={`px-2 sm:px-3 py-2.5 sm:py-3 text-center ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>评级</th>
                  {showRedeemColumn && <th className="px-2 sm:px-3 py-2.5 sm:py-3 text-center">强赎</th>}
                  {showScoreColumns && (
                    <th className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>总分</th>
                  )}
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {filteredData.map((bond, idx) => {
              const isHeld = holdingIds.has(bond.id);
              const isBlacklisted = blacklistIds ? blacklistIds.has(bond.id) : false;
              const isBuy = buyIds ? buyIds.has(bond.id) : false;
              const isSell = sellIds ? sellIds.has(bond.id) : false;
              return (
                <tr
                  key={bond.id}
                  className={`hover:bg-slate-700/50 transition-colors group ${
                    isBlacklisted
                      ? 'bg-red-500/15 border-l-4 border-red-500/60'
                      : isHeld
                        ? 'bg-slate-800/80'
                        : ''
                  }`}
                >
                  {showHoldingColumn && (
                    <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-center">
                      <button 
                        onClick={() => onToggleHolding(bond.id)}
                        className={`transition-all active:scale-90 ${isHeld ? 'text-yellow-400' : 'text-slate-600 hover:text-yellow-400/70'}`}
                        title={isHeld ? "取消持仓/关注" : "加入持仓/关注"}
                      >
                        <Star size={16} fill={isHeld ? "currentColor" : "none"} />
                      </button>
                    </td>
                  )}
                  {onToggleBuy && (
                    <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-center">
                      <button
                        onClick={() => onToggleBuy(bond.id)}
                        className={`transition-all active:scale-90 ${isBuy ? 'text-green-400' : 'text-slate-600 hover:text-green-400/70'}`}
                        title={isBuy ? '取消待买' : '加入待买'}
                      >
                        <ArrowUpCircle size={16} fill={isBuy ? 'currentColor' : 'none'} />
                      </button>
                    </td>
                  )}
                  {onToggleSell && (
                    <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-center">
                      <button
                        onClick={() => onToggleSell(bond.id)}
                        className={`transition-all active:scale-90 ${isSell ? 'text-red-400' : 'text-slate-600 hover:text-red-400/70'}`}
                        title={isSell ? '取消待卖' : '加入待卖'}
                      >
                        <ArrowDownCircle size={16} fill={isSell ? 'currentColor' : 'none'} />
                      </button>
                    </td>
                  )}
                  <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-slate-200 whitespace-nowrap">
                    {isMarketPreset ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => onAddToBlacklist?.(bond.id)}
                          className={`text-[11px] px-1.5 py-0.5 rounded border transition-colors active:scale-95 ${
                            isBlacklisted
                              ? 'border-red-500/40 text-red-300 bg-red-500/10'
                              : 'border-slate-600 text-slate-300 bg-slate-800/40 hover:bg-slate-700/60'
                          } ${onAddToBlacklist ? 'cursor-pointer' : 'cursor-default'}`}
                          title={isBlacklisted ? '已加入黑名单' : '加入黑名单'}
                          disabled={!onAddToBlacklist}
                        >
                          {idx + 1}
                        </button>
                        <button 
                          onClick={() => onToggleHolding(bond.id)}
                          className={`transition-all active:scale-90 ${isHeld ? 'text-yellow-400' : 'text-slate-600 hover:text-yellow-400/70'}`}
                          title={isHeld ? "取消持仓/关注" : "加入持仓/关注"}
                        >
                          <Star size={14} fill={isHeld ? "currentColor" : "none"} />
                        </button>
                        <span>{bond.code}</span>
                      </div>
                    ) : (
                      bond.code
                    )}
                  </td>
                  <td className="px-2 sm:px-3 py-2.5 sm:py-3">
                    <div className="font-medium text-white max-w-[140px] sm:max-w-none truncate">{bond.name}</div>
                  </td>
                  <td className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right font-medium ${bond.price > 130 ? 'text-red-400' : 'text-slate-200'}`}>
                    {bond.price.toFixed(2)}
                  </td>
                  {isMarketPreset && (
                    <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">
                      {Number.isFinite(bond.stockPrice) ? bond.stockPrice.toFixed(2) : '-'}
                    </td>
                  )}
                  <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right">
                    <div className={`flex items-center justify-end gap-1 ${bond.priceChange >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {bond.priceChange >= 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                      {Math.abs(bond.priceChange).toFixed(2)}%
                    </div>
                  </td>
                  {isMarketPreset && (
                    <>
                      <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">{bond.remainingYear.toFixed(2)}</td>
                      <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-center whitespace-nowrap">
                        <span className="px-1.5 py-0.5 rounded text-[10px] border border-slate-600 text-slate-300">
                          {bond.rating}
                        </span>
                      </td>
                      {showAllColumns && (
                        <>
                          <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">{bond.premiumRate.toFixed(2)}%</td>
                          <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">
                            {typeof bond.pureBondPremiumRate === 'number' ? `${bond.pureBondPremiumRate.toFixed(2)}%` : '-'}
                          </td>
                          <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">
                            {typeof bond.ytmRt === 'number' ? `${bond.ytmRt.toFixed(2)}%` : '-'}
                          </td>
                          <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">
                            {typeof bond.currIssAmt === 'number' ? bond.currIssAmt.toFixed(2) : '-'}
                          </td>
                          <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">
                            {typeof bond.forceRedeemPrice === 'number' ? bond.forceRedeemPrice.toFixed(2) : '-'}
                          </td>
                        </>
                      )}
                      {showRedeemColumn && (
                        <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-center whitespace-nowrap">
                          {renderRedeemCell(bond.redeemOngoingDays)}
                        </td>
                      )}
                      {showScoreColumns && (
                        <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">
                          {typeof bond.totalScore === 'number' ? bond.totalScore.toFixed(3) : '-'}
                        </td>
                      )}
                    </>
                  )}
                  {!isHoldingsPreset && !isMarketPreset && (
                    <>
                      <td className={`px-2 sm:px-3 py-2.5 sm:py-3 text-slate-300 ${showAllColumns ? '' : 'hidden sm:table-cell'} max-w-[180px] truncate`}>{bond.stockName || '-'}</td>
                      <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 whitespace-nowrap">{bond.premiumRate.toFixed(2)}%</td>
                      {showScoreColumns && (
                        <td className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
                          {typeof bond.pureBondPremiumRate === 'number'
                            ? `${bond.pureBondPremiumRate.toFixed(2)}%`
                            : '-'}
                        </td>
                      )}
                      <td className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>{bond.remainingYear.toFixed(2)}</td>
                      <td className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>{(bond.turnoverRate ?? 0).toFixed(2)}%</td>
                      <td className={`px-2 sm:px-3 py-2.5 sm:py-3 text-center ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${
                          bond.rating === 'AAA' ? 'border-yellow-500/50 text-yellow-500' :
                          bond.rating === 'AA+' ? 'border-slate-500 text-slate-300' : 'border-slate-600 text-slate-500'
                        }`}>
                          {bond.rating}
                        </span>
                      </td>
                      {showRedeemColumn && (
                        <td className="px-2 sm:px-3 py-2.5 sm:py-3 text-center whitespace-nowrap">
                          {renderRedeemCell(bond.redeemOngoingDays)}
                        </td>
                      )}
                      {showScoreColumns && (
                        <td className={`px-2 sm:px-3 py-2.5 sm:py-3 text-right text-slate-300 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
                          {typeof bond.totalScore === 'number' ? bond.totalScore.toFixed(3) : '-'}
                        </td>
                      )}
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        
        {filteredData.length === 0 && (
          <div className="p-8 text-center text-slate-500 flex flex-col items-center justify-center gap-2">
             <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mb-2">
                <Filter className="text-slate-600" size={24}/>
             </div>
             <p>{emptyMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default BondTable;