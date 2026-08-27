import { ArrayNotEmpty, IsArray, IsNumber } from 'class-validator';

export class ProcessBatchDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsNumber({}, { each: true })
  productIds: number[];
}
